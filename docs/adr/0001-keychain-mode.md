# Keychain Mode as a UI-Only Add-On Layout

Daiza was originally designed to compute how an acrylic figure plate stands on a physical base (neck, claw, slot, footprint, stability angles). The user asked for an additional "keychain mode" that re-uses the same artwork analysis pipeline but produces a hanging charm instead of a standing figure.

We decided to add keychain mode as a **UI-only toggle** that switches the preview and export between two layouts of the same source artwork. In keychain mode the app adds a user-positioned ring hole near the top of the cutline, masks the artwork under the hole, rotates the charm so its center of mass hangs directly below the hole, and shows a purely visual clasp/chain assembly in the 3D preview. The base-mode parameters remain hidden but preserved in state so switching back to base mode does not lose work. The exported SVG is rotated in keychain mode and includes both the outer cutline and the inner ring hole as separate paths.

This keeps the existing base-design workflow intact while treating the keychain as a derivative layout rather than a separate document type. We explicitly rejected making Design Mode part of persisted design state or export metadata to avoid inventing a multi-mode file format before the two layouts have diverged enough to justify it.
