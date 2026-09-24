/** Readable local defaults. The policy is inactive until guard install. */
export function defaultGuardPolicy() {
  return {
    version: 1,
    on_error: 'ask',
    rules: [
      { id: 'force-push', tool: '*', pattern: 'force-push', action: 'block' },
      { id: 'protected-push', tool: '*', pattern: 'protected-push', action: 'ask' },
      { id: 'recursive-delete', tool: '*', pattern: 'recursive-delete-outside-repo', action: 'block' },
      { id: 'pipe-to-shell', tool: '*', pattern: 'pipe-to-interpreter', action: 'ask' },
      { id: 'credential-read', tool: '*', pattern: 'credential-read', action: 'block' },
      { id: 'production-migration', tool: '*', pattern: 'production-migration', action: 'ask' },
    ],
    models: [],
  };
}
