// Basic Auth gate for the dashboard.
// Username: peak10
// Password: from BASIC_AUTH_PASSWORD env var (set in Netlify UI)
import type { Context } from "https://edge.netlify.com";

export default async function handler(req: Request, context: Context) {
  const expectedUser = "peak10";
  const expectedPass = Netlify.env.get("BASIC_AUTH_PASSWORD") ?? "";

  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === expectedUser && pass === expectedPass && expectedPass !== "") {
        return context.next();
      }
    } catch {
      // fall through to 401
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Peak 10 OPEX Lookback", charset="UTF-8"',
      "Content-Type": "text/plain; charset=UTF-8",
    },
  });
}

export const config = { path: "/*" };
