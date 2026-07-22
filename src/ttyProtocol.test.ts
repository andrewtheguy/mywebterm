import { describe, expect, test } from "bun:test";

import {
  buildHandshake,
  decodeFrame,
  encodeInput,
  encodeResize,
  parseClientControl,
  parseSshTarget,
  ServerCommand,
} from "./ttyProtocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ServerCommandValue = (typeof ServerCommand)[keyof typeof ServerCommand];

function createFrame(command: ServerCommandValue, payload: string): ArrayBuffer {
  const payloadBytes = encoder.encode(payload);
  const frame = new Uint8Array(payloadBytes.length + 1);
  frame[0] = String(command).charCodeAt(0);
  frame.set(payloadBytes, 1);
  return frame.buffer;
}

describe("ttyProtocol", () => {
  test("encodes input frame prefix correctly", () => {
    const input = "ls -la";
    const encoded = encodeInput(input);

    expect(encoded[0]).toBe("0".charCodeAt(0));
    expect(decoder.decode(encoded.slice(1))).toBe(input);
  });

  test("encodes resize frame with JSON payload", () => {
    const encoded = encodeResize(120, 40);

    expect(encoded[0]).toBe("1".charCodeAt(0));
    expect(JSON.parse(decoder.decode(encoded.slice(1)))).toEqual({
      columns: 120,
      rows: 40,
    });
  });

  test("decodes OUTPUT command", () => {
    const outputFrame = decodeFrame(createFrame(ServerCommand.OUTPUT, "echo ok"));
    expect(outputFrame.command).toBe(ServerCommand.OUTPUT);
    expect(decoder.decode(outputFrame.payload)).toBe("echo ok");
  });

  test("decodes SET_WINDOW_TITLE command", () => {
    const titleFrame = decodeFrame(createFrame(ServerCommand.SET_WINDOW_TITLE, "bash"));
    expect(titleFrame.command).toBe(ServerCommand.SET_WINDOW_TITLE);
    expect(decoder.decode(titleFrame.payload)).toBe("bash");
  });

  test("decodes SET_PREFERENCES command", () => {
    const preferencesFrame = decodeFrame(createFrame(ServerCommand.SET_PREFERENCES, '{"theme":"dark"}'));
    expect(preferencesFrame.command).toBe(ServerCommand.SET_PREFERENCES);
    expect(decoder.decode(preferencesFrame.payload)).toBe('{"theme":"dark"}');
  });

  test("builds handshake JSON shape", () => {
    const handshake = buildHandshake(100, 33);
    expect(JSON.parse(handshake)).toEqual({
      type: "handshake",
      columns: 100,
      rows: 33,
    });
  });

  test("normalizes handshake dimensions to positive integers", () => {
    const handshake = buildHandshake(100.9, 33.2);
    expect(JSON.parse(handshake)).toEqual({
      type: "handshake",
      columns: 100,
      rows: 33,
    });
  });

  test("parses valid ssh targets", () => {
    expect(parseSshTarget("myhost")).toEqual({ destination: "myhost", port: undefined });
    expect(parseSshTarget("user@myhost")).toEqual({ destination: "user@myhost", port: undefined });
    expect(parseSshTarget("user@myhost:2222")).toEqual({ destination: "user@myhost", port: 2222 });
    expect(parseSshTarget("10.0.0.5:22")).toEqual({ destination: "10.0.0.5", port: 22 });
    expect(parseSshTarget("dev.example.com")).toEqual({ destination: "dev.example.com", port: undefined });
  });

  test("rejects invalid ssh targets", () => {
    expect(parseSshTarget("")).toBeNull();
    expect(parseSshTarget("-oProxyCommand=evil")).toBeNull(); // option injection
    expect(parseSshTarget("user@-badhost")).toBeNull();
    expect(parseSshTarget("host name")).toBeNull();
    expect(parseSshTarget("host:0")).toBeNull();
    expect(parseSshTarget("host:70000")).toBeNull();
    expect(parseSshTarget("host;rm -rf /")).toBeNull();
    expect(parseSshTarget(`a${"b".repeat(300)}`)).toBeNull();
  });

  test("parses handshake with and without sshTarget", () => {
    expect(parseClientControl(JSON.stringify({ type: "handshake", columns: 80, rows: 24 }))).toEqual({
      type: "handshake",
      columns: 80,
      rows: 24,
    });
    expect(
      parseClientControl(JSON.stringify({ type: "handshake", columns: 80, rows: 24, sshTarget: "user@host" })),
    ).toEqual({ type: "handshake", columns: 80, rows: 24, sshTarget: "user@host" });
    expect(
      parseClientControl(JSON.stringify({ type: "handshake", columns: 80, rows: 24, sshTarget: "-oBad" })),
    ).toBeNull();
    expect(parseClientControl(JSON.stringify({ type: "handshake", columns: 80, rows: 24, sshTarget: 5 }))).toBeNull();
  });

  test("throws when handshake dimensions are not finite positive numbers", () => {
    expect(() => buildHandshake(0, 10)).toThrow(TypeError);
    expect(() => buildHandshake(-1, 10)).toThrow(TypeError);
    expect(() => buildHandshake(Number.NaN, 10)).toThrow(TypeError);
    expect(() => buildHandshake(Number.POSITIVE_INFINITY, 10)).toThrow(TypeError);
    expect(() => buildHandshake(10, 0)).toThrow(TypeError);
    expect(() => buildHandshake(10, -1)).toThrow(TypeError);
    expect(() => buildHandshake(10, Number.NaN)).toThrow(TypeError);
    expect(() => buildHandshake(10, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
