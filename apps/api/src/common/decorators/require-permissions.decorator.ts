import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@accounting/types';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares the permissions a caller must hold (ALL of them) for the route.
 * Enforced server-side by PermissionsGuard; the frontend only mirrors this
 * for UX.
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
