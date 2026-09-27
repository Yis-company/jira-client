import { edits } from "./edits";

const active = new Map<string, Promise<void>>();

export function requestEditSync(ownerKey: string) {
  const running = active.get(ownerKey);
  if (running) return running;

  const request = edits.sync().finally(() => {
    if (active.get(ownerKey) === request) active.delete(ownerKey);
  });
  active.set(ownerKey, request);
  return request;
}
