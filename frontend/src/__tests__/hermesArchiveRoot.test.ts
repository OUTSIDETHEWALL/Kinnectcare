const { hermesArchiveRoot } = require('../../plugins/withSchedulingTracing');

describe('pinned Hermes source archive root compatibility', () => {
  const original = `
  from(tarTree(downloadHermesDest)) {
    eachFile {
      if (this.path.startsWith("facebook-hermes-")) {
        this.path = this.path.substringAfter("/")
      }
    }
  }
  `;
  it('flattens both observed owner prefixes without changing the pinned build', () => {
    const patched = hermesArchiveRoot(original);
    expect(patched).toContain('this.path.startsWith("meta-hermes-")');
    expect(patched).toContain('this.path.startsWith("facebook-hermes-")');
    expect(patched.replace(
      '(this.path.startsWith("facebook-hermes-") || this.path.startsWith("meta-hermes-"))',
      'this.path.startsWith("facebook-hermes-")',
    )).toBe(original);
  });
  it('is idempotent across repeated prebuilds', () => {
    expect(hermesArchiveRoot(hermesArchiveRoot(original))).toBe(hermesArchiveRoot(original));
  });
  it('fails explicitly if the pinned upstream extraction shape changes', () => {
    expect(() => hermesArchiveRoot('different source')).toThrow('extraction anchor changed');
  });
});
