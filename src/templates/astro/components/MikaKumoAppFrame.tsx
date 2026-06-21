import { useState, type ReactNode } from "react";
import { Badge, Button, Link, Sidebar, Text, useSidebar } from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";
import {
  BagIcon,
  BookOpenIcon,
  CaretRightIcon,
  CompassIcon,
  FileTextIcon,
  GithubLogoIcon,
  HeartIcon,
  HouseIcon,
  KeyIcon,
  ListIcon,
  PackageIcon,
  ReceiptIcon,
  RobotIcon,
  ShoppingCartSimpleIcon,
  SparkleIcon,
  UserCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";

export interface MikaKumoNavItem {
  readonly label: string;
  readonly href: string;
  readonly badge?: string;
}

interface AppFrameProps {
  readonly title: string;
  readonly currentPath: string;
  readonly productNavItems: readonly MikaKumoNavItem[];
  readonly children: ReactNode;
}

const fixtureLinks: readonly (MikaKumoNavItem & { readonly icon: Icon })[] = [
  { label: "Agent manifest", href: "/.well-known/mika-agent.json", icon: RobotIcon },
  { label: "llms.txt", href: "/llms.txt", icon: FileTextIcon },
  { label: "Action contract", href: "/api/mika-action-contract.json", icon: ReceiptIcon },
  { label: "Admin action testbed", href: "/_emdash/admin", icon: WrenchIcon },
];

export default function MikaKumoAppFrame({
  title,
  currentPath,
  productNavItems,
  children,
}: AppFrameProps) {
  const productsActive = currentPath === "/" || currentPath.startsWith("/products/");

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
                Buttonwood Lot
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
                active={isActive(currentPath, "/")}
                href="/"
                icon={HouseIcon}
                tooltip="Home"
              >
                Home
              </Sidebar.MenuButton>
              <ProductsSidebarMenu
                currentPath={currentPath}
                productNavItems={productNavItems}
                productsActive={productsActive}
              />
              <Sidebar.MenuButton
                active={isActive(currentPath, "/cart")}
                href="/cart"
                icon={ShoppingCartSimpleIcon}
                tooltip="Cart"
              >
                Cart
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/wishlist")}
                href="/wishlist"
                icon={HeartIcon}
                tooltip="Wishlist"
              >
                Wishlist
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                active={isActive(currentPath, "/account")}
                href="/account"
                icon={UserCircleIcon}
                tooltip="Account"
              >
                Account
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>

          <Sidebar.Group>
            <Sidebar.GroupLabel>Fulfillment</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton href="/account" icon={KeyIcon} tooltip="Licenses">
                Licenses
                <Sidebar.MenuBadge>fixture</Sidebar.MenuBadge>
              </Sidebar.MenuButton>
              <Sidebar.MenuButton href="/account" icon={BagIcon} tooltip="Downloads">
                Downloads
              </Sidebar.MenuButton>
              <Sidebar.MenuButton href="/account" icon={CompassIcon} tooltip="Subscriptions">
                Subscriptions
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>

          <Sidebar.Group>
            <Sidebar.GroupLabel>Developer</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {fixtureLinks.map((item) => (
                <Sidebar.MenuButton
                  active={isActive(currentPath, item.href)}
                  href={item.href}
                  icon={item.icon}
                  key={item.href}
                  tooltip={item.label}
                >
                  {item.label}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>

        <Sidebar.Footer>
          <div className="mika-kumo-sidebar-footer">
            <Badge appearance="dot" variant="success">
              Fixture mode
            </Badge>
            <Link
              href="https://github.com/bnomei/emdash-actions"
              target="_blank"
              rel="noreferrer"
              variant="plain"
            >
              <GithubLogoIcon size={16} aria-hidden="true" />
              Actions package
              <Link.ExternalIcon aria-hidden="true" />
            </Link>
          </div>
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
            <span>Buttonwood Lot</span>
          </a>
          <nav aria-label="Quick links" className="mika-kumo-mobile-actions">
            <Link href="/cart" variant="plain" aria-label="Cart">
              <ShoppingCartSimpleIcon size={18} aria-hidden="true" />
            </Link>
            <Link href="/account" variant="plain" aria-label="Account">
              <UserCircleIcon size={18} aria-hidden="true" />
            </Link>
          </nav>
        </div>

        {children}

        <footer className="mika-kumo-footer">
          <div className="mika-kumo-footer-copy">
            <Text as="p" variant="secondary" size="sm">
              Resettable Mika fixture storefront with purchases, stock, subscriptions, licenses,
              downloads, webhooks, and admin actions.
            </Text>
          </div>
          <nav aria-label="Template resources" className="mika-kumo-footer-links">
            <Link href="/.well-known/mika-agent.json" variant="plain">
              Agent
            </Link>
            <Link href="/llms.txt" variant="plain">
              llms.txt
            </Link>
            <Link href="/api/mika-action-contract.json" variant="plain">
              Contract
            </Link>
            <Link href="/_emdash/admin" variant="plain">
              Admin
            </Link>
            <Link
              href="https://github.com/bnomei/emdash-actions"
              target="_blank"
              rel="noreferrer"
              variant="plain"
            >
              <BookOpenIcon size={16} aria-hidden="true" />
              Actions
              <Link.ExternalIcon aria-hidden="true" />
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

function ProductsSidebarMenu({
  currentPath,
  productNavItems,
  productsActive,
}: {
  readonly currentPath: string;
  readonly productNavItems: readonly MikaKumoNavItem[];
  readonly productsActive: boolean;
}) {
  const [productsOpen, setProductsOpen] = useState(productsActive);
  const productMenuId = "mika-kumo-products-menu";

  return (
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        active={productsActive}
        aria-controls={productMenuId}
        aria-expanded={productsOpen}
        icon={PackageIcon}
        onClick={() => setProductsOpen((open) => !open)}
        tooltip="Products"
      >
        Products
        <Sidebar.MenuBadge>{productNavItems.length}</Sidebar.MenuBadge>
        <CaretRightIcon
          aria-hidden="true"
          className="mika-kumo-products-caret"
          data-open={productsOpen ? "true" : undefined}
          size={16}
        />
      </Sidebar.MenuButton>
      <div hidden={!productsOpen} id={productMenuId}>
        <Sidebar.MenuSub>
          <Sidebar.MenuSubButton active={isActive(currentPath, "/")} href="/">
            All products
          </Sidebar.MenuSubButton>
          {productNavItems.map((item) => (
            <Sidebar.MenuSubButton
              active={isActive(currentPath, item.href)}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Sidebar.MenuSubButton>
          ))}
        </Sidebar.MenuSub>
      </div>
    </Sidebar.MenuItem>
  );
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
