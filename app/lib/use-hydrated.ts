import { useEffect, useState } from "react";

/**
 * False during SSR and the first client render, true after mount. Use to defer
 * output that depends on the client environment (locale/timezone date
 * formatting) so the server HTML and first client render match, avoiding React
 * hydration mismatches (#418/#423/#425).
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
