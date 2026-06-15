import { Toast } from "@base-ui/react/toast";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

// Success toasts built on the ru-code UI kit's Toast primitive (@base-ui/react).
export const toastManager = Toast.createToastManager();

export const showSuccess = (message: string): void => {
  toastManager.add({ title: message });
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed inset-x-0 bottom-4 z-50 mx-auto flex max-w-90 flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className="flex w-full items-center gap-2 rounded-lg border border-success/40 bg-success/12 px-4 py-2.5 text-success-foreground shadow-lg/5 backdrop-blur-sm transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <Check className="size-4 shrink-0" />
            <Toast.Title className="font-medium text-sm" />
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function Toaster({ children }: { readonly children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} timeout={2500}>
      {children}
      <ToastList />
    </Toast.Provider>
  );
}
