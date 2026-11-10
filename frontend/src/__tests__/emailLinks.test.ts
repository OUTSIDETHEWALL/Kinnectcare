const mockGet = jest.fn();
const mockSet = jest.fn();
const mockPost = jest.fn();
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: any[]) => mockGet(...args),
  setItemAsync: (...args: any[]) => mockSet(...args),
}));
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: async () => new Uint8Array(32).fill(17),
  digestStringAsync: async () => 'a'.repeat(64),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
jest.mock('../api', () => ({ api: { post: (...args: any[]) => mockPost(...args) } }));
import { parseEmailLink, redeemEmailLink, requestEmailLink } from '../emailLinks';

const token = '1'.repeat(64);
const state = 'a'.repeat(64);
describe('device-bound email links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue(undefined);
    mockPost.mockResolvedValue({ data: { ok: true } });
  });
  it.each([
    `https://kinnectcare-production.up.railway.app/auth/email-link#token=${token}&state=${state}`,
    `kinnship://auth/email-link#token=${token}&state=${state}`,
  ])('accepts a trusted cold or warm link', url => {
    expect(parseEmailLink(url)).toEqual({ token, state });
  });
  it.each([
    `https://attacker.example/auth/email-link#token=${token}&state=${state}`,
    `https://kinnectcare-production.up.railway.app.attacker.example/auth/email-link#token=${token}&state=${state}`,
    `kinnship://invite/${token}`,
    `kinnship://auth/email-link?token=${token}&state=${state}`,
    `kinnship://auth/email-link#token=123456&state=${state}`,
    null,
  ])('rejects an untrusted or incomplete link', url => {
    expect(parseEmailLink(url)).toBeNull();
  });
  it('persists proof before requesting mail and sends only its hash', async () => {
    await requestEmailLink({ email: ' Family@Example.com ', createFamily: true, fullName: 'Family' });
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[0]);
    const body = mockPost.mock.calls[0][1];
    expect(body.challenge).toBe(state);
    expect(body.email).toBe('family@example.com');
    expect(body.verifier).toBeUndefined();
    expect(body.create_family).toBe(true);
  });
  it('never requests mail when durable proof cannot be saved', async () => {
    mockSet.mockRejectedValue(new Error('storage unavailable'));
    await expect(requestEmailLink({ email: 'test@example.com' })).rejects.toThrow('storage unavailable');
    expect(mockPost).not.toHaveBeenCalled();
  });
  it('refuses links requested on another installation', async () => {
    await expect(redeemEmailLink(token, state)).rejects.toThrow('phone where you requested');
    expect(mockPost).not.toHaveBeenCalled();
  });
  it('keeps up to six requests without exceeding Android SecureStore size', async () => {
    const map = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
      i.toString().padStart(64, '0'), { verifier: 'b'.repeat(64), at: Date.now() },
    ]));
    mockGet.mockResolvedValue(JSON.stringify(map));
    await requestEmailLink({ email: 'test@example.com' });
    const saved = mockSet.mock.calls[0][1];
    expect(Object.keys(JSON.parse(saved))).toHaveLength(6);
    expect(saved.length).toBeLessThan(2048);
  });
  it('redeems with the saved installation proof, not a mailbox guess', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ [state]: { verifier: 'b'.repeat(64), at: Date.now() } }));
    await redeemEmailLink(token, state);
    expect(mockPost).toHaveBeenCalledWith('/auth/email-link/verify', {
      token, verifier: 'b'.repeat(64), full_name: '', create_family: false,
    });
  });
  it('rejects proof that expired locally before contacting the server', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ [state]: { verifier: 'b'.repeat(64), at: Date.now() - 16 * 60000 } }));
    await expect(redeemEmailLink(token, state)).rejects.toThrow('new email link');
    expect(mockPost).not.toHaveBeenCalled();
  });
});
