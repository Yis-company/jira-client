import * as React from "react";
import { cn } from "../../lib/utils";

// Adapted from shadcn/ui's Radix Input (MIT), with this pilot's CSS class.
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/radix/ui/input.tsx
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn("ui-input", className)} {...props} />;
}

export { Input };
