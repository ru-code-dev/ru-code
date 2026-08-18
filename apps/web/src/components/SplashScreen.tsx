import { APP_NAME } from "@ru-code/branding";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label={`${APP_NAME} splash screen`}
      >
        <img alt={APP_NAME} className="size-16 object-contain" src="/logo.png" />
      </div>
    </div>
  );
}
