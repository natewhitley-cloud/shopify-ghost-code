import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import styles from "./styles.module.css";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Ghost Code</h1>
        <p className={styles.text}>
          Find and remove leftover code from uninstalled Shopify apps — before it slows down your
          store.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Scan your live theme.</strong> Ghost Code inspects every file in your published
            theme for code left behind by apps you&apos;ve already removed.
          </li>
          <li>
            <strong>See exactly what&apos;s there.</strong> Each finding is mapped to a specific
            file and line so you know exactly what to review.
          </li>
          <li>
            <strong>Stay clean automatically.</strong> Professional plan shops get daily re-scans
            whenever your theme changes, so ghost code never accumulates unnoticed.
          </li>
        </ul>
      </div>
    </div>
  );
}
