import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";

const location = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/repo",
  repository: "enterprise/private",
};
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery).toMatchObject([
      { resource: { url, repository: location.repository } },
      { resource: { url: `${url}-second`, repository: location.repository } },
    ]);
  });

  it("loads Noise gallery images from their public provider URLs without host capabilities", () => {
    const remote = { ...location, directImages: true };
    const cdn = "https://cdn.example.org/image.jpg?signature=abc";
    const blob = "https://github.com/org/repo/blob/main/demo.png";
    expect([url, cdn, blob].map((image) => pullRequestImageSource(image, remote))).toEqual([
      { kind: "image", uri: url },
      { kind: "image", uri: cdn },
      { kind: "image", uri: "https://raw.githubusercontent.com/org/repo/main/demo.png" },
    ]);
    const encrypted = { ...remote, bridgedImages: true };
    expect(pullRequestImageSource(url, encrypted)).toMatchObject({
      resource: { url, repository: location.repository },
    });
    expect(pullRequestImageSource(cdn, encrypted)).toEqual({ kind: "image", uri: cdn });
    expect(pullRequestMediaSource(url, remote, "video")).toMatchObject({
      resource: { url, repository: location.repository },
    });
  });
});
