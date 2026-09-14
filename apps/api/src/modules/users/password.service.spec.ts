import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes and verifies a password', async () => {
    const hash = await service.hash('CorrectHorse1');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'CorrectHorse1')).toBe(true);
    expect(await service.verify(hash, 'wrong')).toBe(false);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await service.verify('not-a-hash', 'x')).toBe(false);
  });
});
