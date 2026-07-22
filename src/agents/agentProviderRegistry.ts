import { AgentProvider } from "./agentProvider";

/** Simple registry so the UI can enumerate and resolve providers by id. */
export class AgentProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  all(): AgentProvider[] {
    return [...this.providers.values()];
  }
}
