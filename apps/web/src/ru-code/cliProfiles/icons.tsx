// ru-code: brand-profile icons + resolver, ALL in one place so the rest of the app
// never hard-codes a per-provider icon. `iconForProfile` / `iconForConfig` map a
// provider instance's profile to its mark; the provider-icon call sites (card,
// model pickers, composer via ProviderInstanceIcon) resolve through here.
//
// The SVGs embed gradient/mask/filter ids; rendering the same icon more than once
// on a page (card + picker + composer at once) would collide those DOM ids, so each
// render uniquifies them via `useId()`. Each root carries `data-cli-profile` so
// tests (and debugging) can assert which mark rendered. See specs/cli-profiles.md.
import { useId } from "react";

import { resolveCliProfile, type CliProfileId } from "@ru-code/branding";
import type { Icon } from "~/components/Icons";

import { readProfileId } from "./profileConfig";

/** Stock qwen mark. */
export const QwenCodeIcon: Icon = (props) => {
  const uid = useId().replace(/:/g, "");
  const g0 = `${uid}-g0`;
  const g1 = `${uid}-g1`;
  return (
    // ru-code: viewBox hugs the artwork (~x 28–175, y 17.5–163) instead of the raw
    // 0–200 canvas, so the glyph fills the frame like the other marks. Path coords +
    // the userSpaceOnUse gradients are unchanged — only the visible window tightens.
    <svg {...props} viewBox="26 15 150 150" fill="none" data-cli-profile="qwen">
      <path
        d="M174.82 108.75L155.38 75L165.64 57.75C166.46 56.31 166.46 54.53 165.64 53.09L155.38 35.84C154.86 34.91 153.87 34.33 152.78 34.33H114.88L106.14 19.03C105.62 18.1 104.63 17.52 103.54 17.52H83.3C82.21 17.52 81.22 18.1 80.7 19.03L61.26 52.77H41.02C39.93 52.77 38.94 53.35 38.42 54.28L28.16 71.53C27.34 72.97 27.34 74.75 28.16 76.19L45.52 107.5L36.78 122.8C35.96 124.24 35.96 126.02 36.78 127.46L47.04 144.71C47.56 145.64 48.55 146.22 49.64 146.22H87.54L96.28 161.52C96.8 162.45 97.79 163.03 98.88 163.03H119.12C120.21 163.03 121.2 162.45 121.72 161.52L141.16 127.78H158.52C159.61 127.78 160.6 127.2 161.12 126.27L171.38 109.02C172.2 107.58 172.2 105.8 171.38 104.36L174.82 108.75Z"
        fill={`url(#${g0})`}
      />
      <path
        d="M119.12 163.03H98.88L87.54 144.71H49.64L61.26 126.39H80.7L38.42 55.29H61.26L83.3 19.03L93.56 37.35L83.3 55.29H161.58L151.32 72.54L170.76 106.28H151.32L141.16 88.34L101.18 163.03H119.12Z"
        fill="white"
      />
      <path d="M127.86 79.83H76.14L101.18 122.11L127.86 79.83Z" fill={`url(#${g1})`} />
      <defs>
        <radialGradient
          id={g0}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(100 100) rotate(90) scale(100)"
        >
          <stop stopColor="#665CEE" />
          <stop offset="1" stopColor="#332E91" />
        </radialGradient>
        <radialGradient
          id={g1}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(100 100) rotate(90) scale(100)"
        >
          <stop stopColor="#665CEE" />
          <stop offset="1" stopColor="#332E91" />
        </radialGradient>
      </defs>
    </svg>
  );
};

/** Custom-fork mark (a distinct, VS Code-style ribbon). */
export const CustomCodeIcon: Icon = (props) => {
  const uid = useId().replace(/:/g, "");
  const mask = `${uid}-mask`;
  const f0 = `${uid}-f0`;
  const f1 = `${uid}-f1`;
  const grad = `${uid}-grad`;
  return (
    <svg {...props} viewBox="0 0 65 64" fill="none" data-cli-profile="custom">
      <mask
        id={mask}
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="2"
        y="3"
        width="60"
        height="60"
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M44.3535 61.7544C45.2869 62.1181 46.3512 62.0948 47.2933 61.6414L59.4948 55.7703C60.7769 55.1533 61.5923 53.8557 61.5923 52.4322V12.6222C61.5923 11.1987 60.777 9.90112 59.4949 9.28418L47.2933 3.41285C46.0569 2.81791 44.6099 2.96363 43.5247 3.75255C43.3697 3.86525 43.222 3.99108 43.0835 4.12975L19.7252 25.44L9.55077 17.7167C8.60361 16.9978 7.27883 17.0567 6.39918 17.8569L3.13591 20.8253C2.05992 21.804 2.05869 23.4968 3.13325 24.4772L11.9568 32.5271L3.13325 40.577C2.05869 41.5574 2.05992 43.2502 3.13591 44.2289L6.39918 47.1974C7.27883 47.9975 8.60361 48.0565 9.55077 47.3375L19.7252 39.6143L43.0835 60.9245C43.453 61.2943 43.8869 61.5726 44.3535 61.7544ZM46.7852 19.0734L29.0617 32.5271L46.7852 45.9807V19.0734Z"
          fill="white"
        />
      </mask>
      <g mask={`url(#${mask})`}>
        <path
          d="M59.5312 9.29282L47.3201 3.41342C45.9066 2.73288 44.2175 3.01995 43.1082 4.12921L3.13374 40.5766C2.05853 41.5569 2.05976 43.2497 3.13641 44.2285L6.40165 47.1969C7.28184 47.9971 8.60745 48.056 9.55514 47.3371L57.6937 10.8181C59.3087 9.59293 61.6283 10.7448 61.6283 12.772V12.6302C61.6283 11.2073 60.8132 9.91011 59.5312 9.29282Z"
          fill="#0065A9"
        />
        <g filter={`url(#${f0})`}>
          <path
            d="M59.5312 55.7611L47.3201 61.6405C45.9066 62.3212 44.2175 62.034 43.1082 60.9247L3.13374 24.4774C2.05853 23.497 2.05976 21.8042 3.13641 20.8255L6.40165 17.857C7.28184 17.0569 8.60745 16.998 9.55514 17.7169L57.6937 54.2358C59.3087 55.461 61.6283 54.3091 61.6283 52.2821V52.4238C61.6283 53.8467 60.8132 55.1438 59.5312 55.7611Z"
            fill="#007ACC"
          />
        </g>
        <g filter={`url(#${f1})`}>
          <path
            d="M47.3208 61.6414C45.9069 62.3216 44.2178 62.0339 43.1084 60.9245C44.4753 62.2914 46.8124 61.3233 46.8124 59.3903V5.66399C46.8124 3.73095 44.4753 2.76287 43.1084 4.12974C44.2178 3.02038 45.9069 2.73291 47.3208 3.41284L59.5297 9.28418C60.8126 9.90112 61.6284 11.1987 61.6284 12.6222V52.4322C61.6284 53.8558 60.8126 55.1534 59.5297 55.7703L47.3208 61.6414Z"
            fill="#1F9CF0"
          />
        </g>
        <g style={{ mixBlendMode: "overlay" }} opacity="0.25">
          <path
            style={{ mixBlendMode: "overlay" }}
            fillRule="evenodd"
            clipRule="evenodd"
            d="M44.3534 61.7544C45.2869 62.118 46.3512 62.0947 47.2933 61.6414L59.4948 55.7703C60.7769 55.1534 61.5923 53.8558 61.5923 52.4322V12.6222C61.5923 11.1986 60.777 9.90109 59.4948 9.28415L47.2933 3.41284C46.0569 2.8179 44.6099 2.96363 43.5247 3.75254C43.3697 3.86524 43.222 3.99107 43.0835 4.12974L19.7252 25.4399L9.55075 17.7167C8.60365 16.9978 7.27883 17.0567 6.39918 17.8568L3.13591 20.8253C2.05992 21.8041 2.05869 23.4968 3.13325 24.4772L11.9568 32.5271L3.13325 40.5771C2.05869 41.5574 2.05992 43.2502 3.13591 44.2289L6.39918 47.1973C7.27883 47.9975 8.60365 48.0564 9.55075 47.3375L19.7252 39.6143L43.0835 60.9245C43.453 61.2942 43.8869 61.5727 44.3534 61.7544ZM46.7852 19.0735L29.0616 32.5271L46.7852 45.9808V19.0735Z"
            fill={`url(#${grad})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={f0}
          x="-6.00521"
          y="8.8815"
          width="75.967"
          height="61.4577"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="4.16667" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={f1}
          x="34.7751"
          y="-5.28549"
          width="35.1867"
          height="75.6257"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="4.16667" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={grad}
          x1="31.9602"
          y1="3.04785"
          x2="31.9602"
          y2="62.0064"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** profile id → its mark. */
export const CLI_PROFILE_ICONS: { readonly [K in CliProfileId]: Icon } = {
  custom: CustomCodeIcon,
  qwen: QwenCodeIcon,
};

/** The mark for a profile id (default profile's mark for unknown ids). */
export function iconForProfile(id: CliProfileId): Icon {
  return CLI_PROFILE_ICONS[id];
}

/** The mark for a provider instance's opaque config blob. */
export function iconForConfig(config: unknown): Icon {
  return CLI_PROFILE_ICONS[resolveCliProfile(readProfileId(config)).id];
}
