# Responsive lifecycle exercises

Lifecycle Exercises uses the shared container-responsive record system. Wide containers show a semantic history table with inline details, compact containers show expandable summary rows, and narrow containers show cards with a focus-managed details drawer.

The creation form stacks at compact widths. Preview targets use wrapping detail cards instead of a horizontally scrolling table. Preview remains non-mutating, expiry is shown next to its identity, and launch requires both an unexpired `PREVIEWED` response and the existing explicit Paper confirmation. The launch area is visually separated from routine controls. Backend target selection, maximum-target enforcement, atomic launch, sequential dispatch, and lifecycle projection behavior are unchanged.

The detail route wraps diagnostic values, converts its fact table to vertical facts on narrow containers, and gives consequential cancellation and target actions full-width touch targets on mobile.
