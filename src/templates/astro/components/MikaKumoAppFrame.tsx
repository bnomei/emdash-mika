// mika-template-version: 0.0.0
/**
 * Cloudflare Kumo sidebar shell for the copyable Mika storefront template.
 * Provides navigation, cart badge, and links to agent discovery routes.
 */
import type { ReactNode } from "react";
import { Button, Link, Sidebar, Text, useSidebar } from "@cloudflare/kumo";
import {
  BagIcon,
  CompassIcon,
  HeartIcon,
  KeyIcon,
  ListIcon,
  PackageIcon,
  ReceiptIcon,
  ShoppingCartSimpleIcon,
  SparkleIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";

interface AppFrameProps {
  readonly title: string;
  readonly brandLabel?: string;
  readonly currentPath: string;
  readonly cartItemCount?: number;
  readonly children: ReactNode;
}

/**
 * Root layout frame with storefront and account navigation.
 *
 * @param title - Page title used in sidebar aria labels.
 * @param brandLabel - Storefront label shown in the sidebar and mobile header.
 * @param currentPath - Active route path for nav highlighting.
 * @param cartItemCount - Optional cart quantity shown in sidebar and mobile bar.
 */
export default function MikaKumoAppFrame({
  title,
  brandLabel = "Storefront",
  currentPath,
  cartItemCount = 0,
  children,
}: AppFrameProps) {
  const productsActive = currentPath === "/" || currentPath.startsWith("/products/");
  const visibleCartItemCount = Math.max(0, cartItemCount);
  const cartLabel = visibleCartItemCount > 0 ? `Cart (${visibleCartItemCount})` : "Cart";
  const cartAriaLabel =
    visibleCartItemCount === 1
      ? "Cart, 1 item"
      : visibleCartItemCount > 1
        ? `Cart, ${visibleCartItemCount} items`
        : "Cart";

  return (
    <Sidebar.Provider
      className="mika-kumo-app-frame"
      defaultOpen
      defaultWidth={272}
      maxWidth={360}
      minWidth={220}
      mobileBreakpoint={900}
      peekable
      resizable
    >
      <Sidebar aria-label={`${title} navigation`} className="mika-kumo-sidebar">
        <Sidebar.Header>
          <a className="mika-kumo-brand" href="/">
            <span className="mika-kumo-brand-mark" aria-hidden="true">
              <SparkleIcon size={18} weight="fill" />
            </span>
            <span className="mika-kumo-brand-copy">
              <Text as="span" variant="heading3">
                {brandLabel}
              </Text>
              <Text as="span" variant="secondary" size="sm">
                Mika storefront
              </Text>
            </span>
          </a>
        </Sidebar.Header>

        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>Storefront</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                active={productsActive}
                href="/"
                icon={PackageIcon}
                tooltip="Products"
              >
                Products
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/cart")}
                href="/cart"
                icon={ShoppingCartSimpleIcon}
                tooltip="Cart"
              >
                {cartLabel}
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/wishlist")}
                href="/wishlist"
                icon={HeartIcon}
                tooltip="Wishlist"
              >
                Wishlist
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>

          <Sidebar.Group>
            <Sidebar.GroupLabel>Account</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                active={currentPath === "/account"}
                href="/account"
                icon={UserCircleIcon}
                tooltip="Profile"
              >
                Profile
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/account/orders")}
                href="/account/orders"
                icon={ReceiptIcon}
                tooltip="Orders"
              >
                Orders
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/account/subscriptions")}
                href="/account/subscriptions"
                icon={CompassIcon}
                tooltip="Subscriptions"
              >
                Subscriptions
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/account/licenses")}
                href="/account/licenses"
                icon={KeyIcon}
                tooltip="Licenses"
              >
                Licenses
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/account/downloads")}
                href="/account/downloads"
                icon={BagIcon}
                tooltip="Downloads"
              >
                Downloads
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>

        <Sidebar.Footer>
          <Sidebar.Trigger aria-label="Collapse navigation" />
        </Sidebar.Footer>
        <Sidebar.Rail aria-label="Toggle navigation rail" />
        <Sidebar.ResizeHandle aria-label="Resize navigation" />
      </Sidebar>

      <div className="mika-kumo-app-main">
        <div className="mika-kumo-mobile-topbar">
          <MobileSidebarTrigger />
          <a className="mika-kumo-mobile-brand" href="/">
            <SparkleIcon size={16} weight="fill" aria-hidden="true" />
            <span>{brandLabel}</span>
          </a>
          <nav aria-label="Quick links" className="mika-kumo-mobile-actions">
            <Link href="/cart" variant="plain" aria-label={cartAriaLabel}>
              <ShoppingCartSimpleIcon size={18} aria-hidden="true" />
              {visibleCartItemCount > 0 && (
                <span className="mika-kumo-mobile-count">({visibleCartItemCount})</span>
              )}
            </Link>
            <Link href="/account" variant="plain" aria-label="Account">
              <UserCircleIcon size={18} aria-hidden="true" />
            </Link>
          </nav>
        </div>

        {children}

        <footer className="mika-kumo-footer">
          <nav aria-label="Agent-readable storefront resources" className="mika-kumo-footer-links">
            <Link href="/.well-known/mika-agent.json" variant="plain">
              Agent manifest
            </Link>
            <Link href="/llms.txt" variant="plain">
              llms.txt
            </Link>
          </nav>
        </footer>
      </div>
    </Sidebar.Provider>
  );
}

function isActive(currentPath: string, href: string) {
  if (href === "/") return currentPath === "/";
  return currentPath === href || currentPath.startsWith(href + "/");
}

function MobileSidebarTrigger() {
  const { isMobile, open, openMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;

  return (
    <Button
      aria-expanded={expanded}
      aria-label={expanded ? "Close navigation" : "Open navigation"}
      className="mika-kumo-mobile-trigger"
      icon={<ListIcon size={18} aria-hidden="true" />}
      onClick={() => {
        if (isMobile) {
          setOpenMobile(!openMobile);
        } else {
          toggleSidebar();
        }
      }}
      shape="square"
      type="button"
      variant="ghost"
    />
  );
}
