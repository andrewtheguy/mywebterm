import { describe, expect, test } from "bun:test";

import { ServerCommand, buildHandshake, decodeFrame, encodeInput, encodeResize } from "./ttydProtocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createFrame(command: string, payload: string): ArrayBuffer {
  const payloadBytes = encoder.encode(payload);
  const frame = new Uint8Array(payloadBytes.length + 1);
  frame[0] = command.charCodeAt(0);
  frame.set(payloadBytes, 1);
  return frame.buffer;
}

describe("ttydProtocol", () => {
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
      columns: 100,
      rows: 33,
    });
  });

  test("normalizes handshake dimensions to positive integers", () => {
    const handshake = buildHandshake(100.9, 33.2);
    expect(JSON.parse(handshake)).toEqual({
      columns: 100,
      rows: 33,
    });
  });

  test("throws when handshake dimensions are not finite positive numbers", () => {
    expect(() => buildHandshake(0, 10)).toThrow(TypeError);
    expect(() => buildHandshake(-1, 10)).toThrow(TypeError);
    expect(() => buildHandshake(Number.NaN, 10)).toThrow(TypeError);
    expect(() => buildHandshake(Number.POSITIVE_INFINITY, 10)).toThrow(TypeError);
    expect(() => buildHandshake(10, 0)).toThrow(TypeError);
  });
});
