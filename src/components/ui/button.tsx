import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// Adapted from shadcn/ui's Radix Button (MIT), with this pilot's CSS classes.
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/radix/ui/button.tsx
const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button-default",
      secondary: "ui-button-secondary",
    },
    size: {
      default: "ui-button-size-default",
      icon: "ui-button-size-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
