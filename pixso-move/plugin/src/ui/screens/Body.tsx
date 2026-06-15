import { Frame, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent } from "~/components/ui/card";
import type { UiState } from "~/state/types";

interface BodyProps {
  readonly state: UiState;
}

function EmptyGuide() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <Frame className="size-10 text-muted-foreground/60" />
      <h2 className="font-semibold text-base">Выберите фрейм</h2>
      <p className="max-w-xs text-muted-foreground text-sm">
        Выделите один фрейм на холсте, чтобы отправить его на анализ.
      </p>
    </div>
  );
}

export function Body({ state }: BodyProps) {
  const { selectionVerdict, preview, sendError } = state;

  if (sendError) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="error">
          <TriangleAlert />
          <AlertTitle>Не удалось отправить</AlertTitle>
          <AlertDescription>{sendError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!selectionVerdict.ok) {
    if (selectionVerdict.reason === "multiple") {
      return (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Выберите только один фрейм</AlertTitle>
          <AlertDescription>
            Несколько несвязанных элементов из разных фреймов отправить нельзя.
          </AlertDescription>
        </Alert>
      );
    }
    return <EmptyGuide />;
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {preview ? (
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <img
              src={`data:image/png;base64,${preview}`}
              alt={selectionVerdict.node.name}
              className="block w-full"
            />
          </div>
        ) : (
          <div className="aspect-video w-full animate-pulse rounded-lg bg-muted" />
        )}
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-sm">{selectionVerdict.node.name}</p>
          <p className="text-muted-foreground text-xs">Готово к отправке</p>
        </div>
      </CardContent>
    </Card>
  );
}
