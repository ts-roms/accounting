import { DemoBankConnector } from './demo-bank.connector';
import { DemoEcommerceConnector } from './demo-ecommerce.connector';
import { DemoOAuthCrmConnector } from './demo-oauth-crm.connector';
import { DemoPaymentGatewayConnector } from './demo-payment-gateway.connector';
import { DemoProcurementConnector } from './demo-procurement.connector';
import { DemoTaxAuthorityConnector } from './demo-tax-authority.connector';
import { StripeConnector } from './stripe/stripe.connector';

/**
 * Connector catalogue. To add a provider: implement `IntegrationConnector`
 * (extend `BaseConnector`), export the class here - nothing else changes.
 * See docs/integrations/connector-development.md.
 */
export const CONNECTOR_CLASSES = [
  DemoBankConnector,
  DemoPaymentGatewayConnector,
  DemoEcommerceConnector,
  DemoTaxAuthorityConnector,
  DemoOAuthCrmConnector,
  DemoProcurementConnector,
  StripeConnector,
] as const;

export const CONNECTORS = Symbol('CONNECTORS');
