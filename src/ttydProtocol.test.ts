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

  test("decodes output/title/preferences commands", () => {
    const outputFrame = decodeFrame(createFrame(ServerCommand.OUTPUT, "echo ok"));
    expect(outputFrame.command).toBe(ServerCommand.OUTPUT);
    expect(decoder.decode(outputFrame.payload)).toBe("echo ok");

    const titleFrame = decodeFrame(createFrame(ServerCommand.SET_WINDOW_TITLE, "bash"));
    expect(titleFrame.command).toBe(ServerCommand.SET_WINDOW_TITLE);
    expect(decoder.decode(titleFrame.payload)).toBe("bash");

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
});
