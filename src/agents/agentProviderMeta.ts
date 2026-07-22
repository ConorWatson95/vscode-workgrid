/**
 * Visual identity for each agent provider, so the chat panel can be
 * colour-coded by which AI is running. Provider-neutral by design: adding a new
 * provider is just another entry here.
 */
export interface ProviderVisual {
  id: string;
  displayName: string;
  /** Accent colour (hex) used for the header, user bubbles and focus ring. */
  accent: string;
  /** Short glyph/badge shown next to the name. */
  badge: string;
}

const PROVIDERS: Record<string, ProviderVisual> = {
  "claude-chat": {
    id: "claude-chat",
    displayName: "Claude",
    accent: "#d97757", // Anthropic clay
    badge: "✳",
  },
  "claude-code": {
    id: "claude-code",
    displayName: "Claude",
    accent: "#d97757",
    badge: "✳",
  },
  // Future providers (placeholders for when they are implemented):
  codex: { id: "codex", displayName: "Codex", accent: "#10a37f", badge: "◇" },
  gemini: { id: "gemini", displayName: "Gemini", accent: "#4285f4", badge: "◆" },
};

const FALLBACK: ProviderVisual = {
  id: "unknown",
  displayName: "Agent",
  accent: "#8a8a8a",
  badge: "●",
};

export function providerVisual(id: string): ProviderVisual {
  return PROVIDERS[id] ?? FALLBACK;
}
