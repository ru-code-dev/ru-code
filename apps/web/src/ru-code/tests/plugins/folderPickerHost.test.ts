// ru-code v2 (S33 A5): a plugin's `pickFolder` never takes the palette away from the user.
import { describe, expect, it } from "vite-plus/test";

import { folderPickerMayOpen } from "../../plugins/FolderPickerPalette";

describe("folderPickerMayOpen", () => {
  it("opens only when the palette is closed, or already in `folder` mode", () => {
    expect(folderPickerMayOpen({ open: false, mode: "command" })).toBe(true);
    expect(folderPickerMayOpen({ open: false, mode: "files" })).toBe(true);
    expect(folderPickerMayOpen({ open: true, mode: "folder" })).toBe(true);
  });

  it("waits while the user is in ⌘K, ⌘P or ⇧⌘F — the request stays pending, the promise untouched", () => {
    expect(folderPickerMayOpen({ open: true, mode: "command" })).toBe(false);
    expect(folderPickerMayOpen({ open: true, mode: "files" })).toBe(false);
    expect(folderPickerMayOpen({ open: true, mode: "content" })).toBe(false);
  });
});
