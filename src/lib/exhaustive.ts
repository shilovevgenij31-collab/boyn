/**
 * Use in the `default` branch of a switch over a closed union/enum. If a new
 * variant is ever added without adding a case for it, TypeScript will refuse
 * to compile the call site — the `never` parameter type is the whole point.
 * See CLAUDE.md rule 6.
 *
 * @example
 * switch (tier) {
 *   case "CORE": ...
 *   case "ACTIVE": ...
 *   default: return assertNever(tier, "tracking tier");
 * }
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(`Unhandled case${context ? ` in ${context}` : ""}: ${JSON.stringify(value)}`);
}
