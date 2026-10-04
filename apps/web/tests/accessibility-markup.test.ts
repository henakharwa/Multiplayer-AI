import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ConnectChannelModal from "../app/_components/ConnectChannelModal";

describe("accessible interactive markup", () => {
  it("identifies the integration picker as a labelled modal dialog", () => {
    const markup = renderToStaticMarkup(createElement(ConnectChannelModal, { workspaceId: "workspace-1", onClose: () => {} }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="connect-channel-title"');
    expect(markup).toContain('id="connect-channel-title"');
  });
});
