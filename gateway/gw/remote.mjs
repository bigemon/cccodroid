import { NEXT } from "./http.mjs";
import { managedRemoteRoute, startManagedRemote } from "./remote/manager.mjs";
export { startManagedRemote };
export async function routeRemote(req, res, u, p) {
  if (p !== "/api/remote/page" && p !== "/api/remote/control") return NEXT;
  await managedRemoteRoute(req, res, u, p);
}
