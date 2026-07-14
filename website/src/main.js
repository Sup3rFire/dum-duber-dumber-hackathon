import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sections.css";

// Scroll-reveal is progressive enhancement only: elements marked `.reveal`
// are fully visible by default. We only hide-then-fade them in if the
// visitor's OS allows motion AND IntersectionObserver exists — by adding
// `.has-reveal` to <html>, which is what the CSS hides on. No JS / reduced
// motion => everything just stays visible, no broken/invisible content.
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

if (!prefersReducedMotion && "IntersectionObserver" in window) {
  document.documentElement.classList.add("has-reveal");

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
  );

  document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
}
