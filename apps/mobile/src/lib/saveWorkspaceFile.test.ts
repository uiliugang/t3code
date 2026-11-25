import { expect, it, vi } from "vite-plus/test";
import { isForegroundHandoffActive } from "./foreground-handoff";
import { saveWorkspaceFile } from "./saveWorkspaceFile";

const fs = vi.hoisted(() => ({ pickDirectory: vi.fn(), openSource: vi.fn() }));
vi.mock("expo-file-system", () => ({
  Directory: { pickDirectoryAsync: fs.pickDirectory },
  File: function (uri: string) {
    return fs.openSource(uri);
  },
  FileMode: { ReadOnly: "r", WriteOnly: "w" },
}));

function setup(bytes: Uint8Array) {
  const controller = new AbortController();
  const existing = Uint8Array.of(17);
  const documents: Uint8Array[] = [existing];
  let cursor = 0;
  const reader = {
    close: vi.fn(),
    readBytes: vi.fn(async (length: number) => {
      const part = bytes.subarray(cursor, cursor + length);
      cursor += part.byteLength;
      return part;
    }),
  };
  const writer = {
    close: vi.fn(),
    writeBytes: vi.fn(async (part: Uint8Array) => {
      documents.push(part);
    }),
  };
  const destination = {
    exists: true,
    open: () => writer,
    delete: vi.fn(() => documents.splice(1)),
  };
  const directory = { createFile: vi.fn(() => destination) };
  fs.openSource.mockReturnValue({ size: bytes.length, open: () => reader });
  fs.pickDirectory.mockImplementation(async () => {
    expect(isForegroundHandoffActive()).toBe(true);
    return directory;
  });
  const input = {
    name: "file.bin",
    mimeType: "application/octet-stream",
    signal: controller.signal,
    resolveUri: vi.fn(async () => "file:///cache/file.bin"),
  };
  return { input, directory, destination, reader, writer, documents, controller };
}

it("streams the entire private copy into a newly created document, including empty files", async () => {
  for (const bytes of [new Uint8Array(0), Uint8Array.from({ length: 700_000 }, (_, i) => i)]) {
    const { input, directory, destination, reader, writer, documents } = setup(bytes);
    expect(await saveWorkspaceFile(input)).toBe(true);
    expect(isForegroundHandoffActive()).toBe(false);
    expect(directory.createFile).toHaveBeenCalledWith(input.name, input.mimeType);
    expect(documents[0]).toStrictEqual(Uint8Array.of(17));
    expect(Buffer.concat(documents.slice(1))).toStrictEqual(Buffer.from(bytes));
    if (bytes.length) expect(writer.writeBytes.mock.calls.length).toBeGreaterThan(1);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(writer.close).toHaveBeenCalledOnce();
    expect(destination.delete).not.toHaveBeenCalled();
  }
});

it("cancels directory selection without downloading, and reports other picker failures", async () => {
  const { input, directory } = setup(new Uint8Array());
  fs.pickDirectory.mockRejectedValueOnce(
    Object.assign(new Error(), { code: "ERR_PICKER_CANCELLED" }),
  );
  expect(await saveWorkspaceFile(input)).toBe(false);
  expect(input.resolveUri).not.toHaveBeenCalled();
  expect(directory.createFile).not.toHaveBeenCalled();
  expect(isForegroundHandoffActive()).toBe(false);
  fs.pickDirectory.mockRejectedValueOnce(new Error("denied"));
  await expect(saveWorkspaceFile(input)).rejects.toThrow("denied");
});

it("removes only the new document when the write fails or is interrupted", async () => {
  for (const abort of [false, true]) {
    const { input, destination, reader, writer, documents, controller } = setup(Uint8Array.of(3));
    writer.writeBytes.mockImplementationOnce(async () => {
      if (abort) controller.abort();
      else throw new Error("out of space");
    });
    if (abort) expect(await saveWorkspaceFile(input)).toBe(false);
    else await expect(saveWorkspaceFile(input)).rejects.toThrow("out of space");
    expect(destination.delete).toHaveBeenCalledOnce();
    expect(documents).toStrictEqual([Uint8Array.of(17)]);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(writer.close).toHaveBeenCalledOnce();
  }
});
