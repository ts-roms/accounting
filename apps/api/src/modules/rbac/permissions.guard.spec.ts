import { PermissionsGuard } from './permissions.guard';
import { PermissionDeniedError } from '@/common/errors/app-error';

describe('PermissionsGuard.hasAll', () => {
  it('passes when every required permission is granted', () => {
    expect(PermissionsGuard.hasAll(new Set(['a', 'b']), ['a'])).toBe(true);
    expect(PermissionsGuard.hasAll(new Set(['a']), [])).toBe(true);
  });

  it('throws PermissionDeniedError listing the missing permissions', () => {
    expect(() => PermissionsGuard.hasAll(new Set(['a']), ['a', 'b'])).toThrow(
      PermissionDeniedError,
    );
    try {
      PermissionsGuard.hasAll(new Set(), ['x']);
    } catch (err) {
      expect((err as PermissionDeniedError).details).toEqual({ required: ['x'] });
    }
  });
});
