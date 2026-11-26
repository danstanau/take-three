import { afterEach, describe, expect, it, vi } from "vitest";
import { connectGoogle, connectMicrosoft, createSharePointLink, uploadGoogle, uploadSharePoint } from "./cloud";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime cloud configuration", () => {
  it("uses the current Microsoft settings for each desktop connection", async () => {
    const connect = vi.fn().mockResolvedValue("access");
    vi.stubGlobal("window", { takeThreeDesktop: { connect } });
    await connectMicrosoft("client-one", "tenant-one");
    await connectMicrosoft("client-two", "tenant-two");
    expect(connect).toHaveBeenLastCalledWith({
      provider: "SharePoint",
      clientId: "client-two",
      tenantId: "tenant-two",
    }, undefined);
  });

  it("passes the Microsoft device code callback to the desktop bridge", async () => {
    const connect = vi.fn().mockImplementation(async (_config, onDeviceCode) => {
      onDeviceCode("ABCD1234");
      return "access";
    });
    const onDeviceCode = vi.fn();
    vi.stubGlobal("window", { takeThreeDesktop: { connect } });
    await connectMicrosoft("client", "tenant", onDeviceCode);
    expect(onDeviceCode).toHaveBeenCalledWith("ABCD1234");
  });

  it("requires a desktop secret before opening Google sign-in", async () => {
    const connect = vi.fn();
    vi.stubGlobal("window", { takeThreeDesktop: { connect } });
    await expect(connectGoogle("client", "")).rejects.toThrow("desktop client secret");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("SharePoint uploads", () => {
  it("uses the chosen site and sends sequential chunks without the Graph token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "site,id" }))
      .mockResolvedValueOnce(json({ id: "drive/id" }))
      .mockResolvedValueOnce(json({ uploadUrl: "https://upload.example/session" }))
      .mockResolvedValueOnce(json({ nextExpectedRanges: ["10485760-"] }, 202))
      .mockResolvedValueOnce(json({ id: "item/id", name: "Demo.webm", webUrl: "https://tenant.sharepoint.com/file" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const blob = new Blob([new Uint8Array(10 * 1024 * 1024 + 8)]);

    const result = await uploadSharePoint("token", "https://tenant.sharepoint.com/sites/my%20team", "Demo", blob, progress);

    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.microsoft.com/v1.0/sites/tenant.sharepoint.com:/sites/my%20team");
    expect(fetchMock.mock.calls[2][0]).toContain("/drives/drive%2Fid/root:/Demo.webm:/createUploadSession");
    expect(fetchMock.mock.calls[3][1].headers).toEqual({ "Content-Range": "bytes 0-10485759/10485768" });
    expect(fetchMock.mock.calls[4][1].headers).toEqual({ "Content-Range": "bytes 10485760-10485767/10485768" });
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(result).toEqual({ provider: "SharePoint", name: "Demo.webm", url: "https://tenant.sharepoint.com/file", driveId: "drive/id", itemId: "item/id" });
  });

  describe("SharePoint sharing links", () => {
    it("requests and returns a public view link without removing inherited permissions", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json({
        link: { type: "view", scope: "anonymous", webUrl: "https://tenant.sharepoint.com/:v:/s/team/public" },
      }, 201));
      vi.stubGlobal("fetch", fetchMock);
      const url = await createSharePointLink("token", "drive/id", "item/id");
      expect(url).toBe("https://tenant.sharepoint.com/:v:/s/team/public");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://graph.microsoft.com/v1.0/drives/drive%2Fid/items/item%2Fid/createLink",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
          body: JSON.stringify({ type: "view", scope: "anonymous", retainInheritedPermissions: true }),
        }),
      );
    });

    it("reports sharing policy failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Sharing is disabled" } }, 403)));
      await expect(createSharePointLink("token", "drive", "item")).rejects.toThrow("Sharing is disabled");
    });

    it("does not claim public access when the returned link has another scope", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
        link: { type: "view", scope: "organization", webUrl: "https://tenant.sharepoint.com/link" },
      })));
      await expect(createSharePointLink("token", "drive", "item")).rejects.toThrow("did not confirm");
    });

  });

  it("rejects invalid site URLs without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadSharePoint("token", "https://example.com/sites/team", "Demo", new Blob(["data"]), vi.fn()))
      .rejects.toThrow("SharePoint site URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports provider errors rather than creating a success result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Permission denied" } }, 403)));
    await expect(uploadSharePoint("token", "https://tenant.sharepoint.com/sites/team", "Demo", new Blob(["data"]), vi.fn()))
      .rejects.toThrow("Permission denied");
  });
});

describe("Google Drive uploads", () => {
  it("uses acknowledged byte ranges and returns the actual uploaded file", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-8388607" } }))
      .mockResolvedValueOnce(json({ id: "file-id", name: "Demo.webm", webViewLink: "https://drive.google.com/file/d/file-id/view" }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const blob = new Blob([new Uint8Array(8 * 1024 * 1024 + 8)]);

    const result = await uploadGoogle("token", "Demo", blob, progress);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer token");
    expect(fetchMock.mock.calls[1][1].headers["Content-Range"]).toBe("bytes 0-8388607/8388616");
    expect(fetchMock.mock.calls[2][1].headers["Content-Range"]).toBe("bytes 8388608-8388615/8388616");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(result.url).toBe("https://drive.google.com/file/d/file-id/view");
  });

  it("does not claim success when a provider fails to acknowledge a chunk", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadGoogle("token", "Demo", new Blob(["data"]), vi.fn()))
      .rejects.toThrow("unexpected upload position");
  });

  it("rejects empty recordings before requesting an upload session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadGoogle("token", "Demo", new Blob(), vi.fn())).rejects.toThrow("empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
