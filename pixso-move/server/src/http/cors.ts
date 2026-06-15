import { HttpRouter } from "effect/unstable/http";

// Open CORS so the cross-origin Pixso plugin can post; `x-designer-id` is the
// auth header. The middleware also answers OPTIONS preflight automatically.
export const corsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const corsAllowedHeaders = ["content-type", "x-designer-id"] as const;

export const corsLayer = HttpRouter.cors({
  allowedMethods: [...corsAllowedMethods],
  allowedHeaders: [...corsAllowedHeaders],
  maxAge: 600,
});
