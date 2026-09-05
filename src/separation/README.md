# Separation next phase

Planned service boundary:

1. Full mix -> drums / bass / vocals / other
2. Drum stem -> kick / snare / hats / cymbals / toms
3. Feed clean stems/sub-stems into the existing translation pipeline

The frontend should depend only on `types.ts`, not on a specific separator implementation.
