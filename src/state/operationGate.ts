export type OperationToken = number;

export type OperationGate = {
  begin: () => OperationToken;
  invalidate: () => void;
  isCurrent: (token: OperationToken) => boolean;
};

export function createOperationGate(): OperationGate {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token === generation;
    },
  };
}
