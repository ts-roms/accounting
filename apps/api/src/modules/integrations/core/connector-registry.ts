import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@/common/errors/app-error';
import type { ConnectorDescriptor, IntegrationConnector } from './connector';

/**
 * Provider -> connector lookup. Connectors self-register at module init
 * (`CONNECTORS` provider token), so adding a provider is one file plus one
 * line in `connectors/index.ts`.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, IntegrationConnector>();

  register(connector: IntegrationConnector): void {
    const key = connector.descriptor.provider;
    if (this.connectors.has(key)) throw new Error(`Connector ${key} registered twice.`);
    this.connectors.set(key, connector);
  }

  get(provider: string): IntegrationConnector {
    const connector = this.connectors.get(provider);
    if (!connector) throw new NotFoundError('Integration provider', provider);
    return connector;
  }

  has(provider: string): boolean {
    return this.connectors.has(provider);
  }

  list(): ConnectorDescriptor[] {
    return [...this.connectors.values()]
      .map((c) => c.descriptor)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }
}
