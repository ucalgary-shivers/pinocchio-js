let _initialized = false;
let _version = "";

export async function initPinocchio(): Promise<{ version: string }> {
  if (_initialized) {
    return { version: _version };
  }

  const pinModule = await import("pinocchio-js");
  await pinModule.default();
  _version = "1.2.2";
  _initialized = true;
  return { version: _version };
}

export function isInitialized(): boolean {
  return _initialized;
}
