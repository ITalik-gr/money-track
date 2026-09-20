import { useGetMeQuery } from "../../store/api.ts";

/**
 * §FOP-GATE — may THIS reader see the ФОП module at all?
 *
 * The client half of the gate whose server half is the 404 over `/tax/*`. Both are needed and
 * neither is decoration: the server one is the one that holds, and this one is what keeps a
 * hidden module from announcing itself anyway — `apiErrorMiddleware` toasts every failed request,
 * so a component that asked and was refused would put «404» on the screen of a user who is not
 * supposed to know the surface exists.
 *
 * Reads `/me`, which every screen already holds, so the answer costs no request. A demo session
 * carries no `user`, which is exactly right: a stranger must not meet a half-built tax screen.
 */
export function useFopVisible(): boolean {
  const { data } = useGetMeQuery();
  return data?.user?.is_owner === true;
}
