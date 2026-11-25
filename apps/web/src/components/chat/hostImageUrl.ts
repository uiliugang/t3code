import { createContext, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

/**
 * Where markdown loads an image file on the host by its absolute path, when the page has no
 * environment to ask. The guest page sets it to its own route.
 */
type ImageUrl = string | Atom.Atom<string | undefined>;
export const HostImageUrlContext = createContext<((path: string) => ImageUrl) | null>(null);
const direct = Atom.family((url: string) => Atom.make<string | undefined>(url));
export function ResolvedHostImage({
  source,
  children,
}: {
  source: ImageUrl;
  children: (url: string) => ReactNode;
}) {
  const url = useAtomValue(typeof source === "string" ? direct(source) : source);
  return url ? children(url) : null;
}
