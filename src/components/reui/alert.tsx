import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const alertVariants = cva("reui-alert", {
  variants: {
    variant: {
      default: "reui-alert-default",
      destructive: "reui-alert-destructive",
      info: "reui-alert-info",
      success: "reui-alert-success",
      warning: "reui-alert-warning",
      invert: "reui-alert-invert",
    },
  },
  defaultVariants: { variant: "default" },
});

function Alert(
  { className, variant, role = "alert", ...props }:
    & HTMLAttributes<HTMLDivElement>
    & VariantProps<typeof alertVariants>,
) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}
function AlertTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="alert-title"
      className={cn("reui-alert-title", className)}
      {...props}
    />
  );
}
function AlertDescription(
  { className, ...props }: HTMLAttributes<HTMLDivElement>,
) {
  return (
    <div
      data-slot="alert-description"
      className={cn("reui-alert-description", className)}
      {...props}
    />
  );
}
function AlertAction({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="alert-action"
      className={cn("reui-alert-action", className)}
      {...props}
    />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
