"use client";

import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type LocationState =
  | { status: "idle" | "locating" | "loading"; place?: PlaceData }
  | { status: "ready"; place: PlaceData }
  | { status: "error"; message: string; place?: PlaceData };

type PlaceData = {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  weather: CurrentWeather;
  hourly?: CurrentWeather[];
};

type CurrentWeather = {
  time: string;
  isDay: boolean;
  temperature: number;
  code: number;
  cloudCover: number;
  precipitation: number;
  rain: number;
  windSpeed: number;
  windGusts: number;
  windDirection: number;
};

type SkyTheme = {
  background: string;
  textClass: string;
  panelClass: string;
};

const defaultPlace: PlaceData = {
  name: "Funchal",
  country: "Portugal",
  latitude: 32.6669,
  longitude: -16.9241,
  timezone: "Atlantic/Madeira",
  weather: {
    time: "2026-05-13T23:00",
    isDay: false,
    temperature: -1,
    code: 45,
    cloudCover: 86,
    precipitation: 0,
    rain: 0,
    windSpeed: 8,
    windGusts: 16,
    windDirection: 80,
  },
  hourly: buildFallbackHourlyForecast("2026-05-13T23:00"),
};

export function WeatherDashboard() {
  const [location, setLocation] = useState<LocationState>({
    status: "ready",
    place: defaultPlace,
  });
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHasTyped, setSearchHasTyped] = useState(false);
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const [displayedHour, setDisplayedHour] = useState(0);
  const [fadingBg, setFadingBg] = useState<string | null>(null);
  const [fadeOut, setFadeOut] = useState(false);
  const [timelineDragging, setTimelineDragging] = useState(false);
  const [touchTooltipVisible, setTouchTooltipVisible] = useState(false);
  const [touchTooltipFading, setTouchTooltipFading] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);
  const [defaultPlaceLoaded, setDefaultPlaceLoaded] = useState(false);
  const compactSearchMeasureRef = useRef<HTMLSpanElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineTickRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const touchTooltipTimeoutRef = useRef<number | null>(null);

  const place = "place" in location ? location.place : undefined;
  const activePlace = place ?? defaultPlace;
  const hourlyForecast = activePlace.hourly?.length
    ? activePlace.hourly
    : [activePlace.weather];
  const activeHourIndex = Math.min(displayedHour, hourlyForecast.length - 1);
  const activeWeather =
    hourlyForecast[Math.min(activeHourIndex, hourlyForecast.length - 1)] ??
    activePlace.weather;
  const isBusy = location.status === "locating" || location.status === "loading";
  const sky = getSkyTheme(activeWeather);

  const getTimelineHourIndex = (clientX: number) => {
    const ticks = timelineTickRefs.current;

    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < ticks.length; index += 1) {
      const tick = ticks[index];
      if (!tick) continue;

      const rect = tick.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const distance = Math.abs(clientX - centerX);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }

    return closestIndex;
  };

  const updateTimelineInteraction = (clientX: number, shouldSelect: boolean) => {
    const index = getTimelineHourIndex(clientX);
    setHoveredHour(index);

    if (shouldSelect) {
      setDisplayedHour(index);
    }
  };

  const clearTouchTooltipTimer = () => {
    if (touchTooltipTimeoutRef.current !== null) {
      window.clearTimeout(touchTooltipTimeoutRef.current);
      touchTooltipTimeoutRef.current = null;
    }
  };

  const showTouchTooltip = () => {
    clearTouchTooltipTimer();
    setTouchTooltipFading(false);
    setTouchTooltipVisible(true);
  };

  const scheduleTouchTooltipHide = () => {
    clearTouchTooltipTimer();
    touchTooltipTimeoutRef.current = window.setTimeout(() => {
      setTouchTooltipFading(true);
      touchTooltipTimeoutRef.current = window.setTimeout(() => {
        setTouchTooltipFading(false);
        setTouchTooltipVisible(false);
        setHoveredHour(null);
        touchTooltipTimeoutRef.current = null;
      }, 220);
    }, 1800);
  };
  const placeLabel = `${activePlace.name}${activePlace.country ? `, ${activePlace.country}` : ""}`;
  const [compactSearchWidth, setCompactSearchWidth] = useState(160);

  function openSearch() {
    setSearchOpen(true);
    setSearchHasTyped(false);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchHasTyped(false);
    setQuery("");
  }

  function handleLocationAllow() {
    setHasEntered(true);
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          loadPlaceByCoordinates(
            position.coords.latitude,
            position.coords.longitude,
          ).catch(() => undefined);
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 10 * 60 * 1000, timeout: 10_000 },
      );
    }
  }

  function handleLocationDeny() {
    setHasEntered(true);
  }

  useLayoutEffect(() => {
    function measureCompactSearch() {
      if (compactSearchMeasureRef.current) {
        setCompactSearchWidth(Math.ceil(compactSearchMeasureRef.current.scrollWidth));
      }
    }

    measureCompactSearch();
    requestAnimationFrame(measureCompactSearch);
    document.fonts?.ready.then(measureCompactSearch).catch(() => undefined);
  }, [defaultPlaceLoaded, hasEntered, placeLabel]);

  useEffect(() => {
    if (!searchOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        closeSearch();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || searchHasTyped) return;

    const idleTimer = window.setTimeout(() => {
      closeSearch();
    }, 5000);

    return () => window.clearTimeout(idleTimer);
  }, [searchOpen, searchHasTyped]);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const currentBgRef = useRef(sky.background);
  useEffect(() => {
    if (sky.background !== currentBgRef.current) {
      setFadingBg(currentBgRef.current);
      setFadeOut(false);
      currentBgRef.current = sky.background;
      requestAnimationFrame(() => requestAnimationFrame(() => setFadeOut(true)));
    }
  }, [sky.background]);

  useEffect(() => {
    const handleMouseUp = () => setTimelineDragging(false);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  useEffect(() => () => clearTouchTooltipTimer(), []);

  useEffect(() => {
    let cancelled = false;

    loadPlaceByCoordinates(defaultPlace.latitude, defaultPlace.longitude)
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setDefaultPlaceLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const date = useMemo(
    () => formatWeatherDate(activeWeather.time),
    [activeWeather.time],
  );

  async function loadPlaceByQuery(value: string) {
    const trimmed = value.trim();

    if (!trimmed) {
      return;
    }

    setLocation((current) => ({
      status: "loading",
      place: "place" in current ? current.place : activePlace,
    }));

    const response = await fetch(`/api/location?q=${encodeURIComponent(trimmed)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Could not find that location.");
    }

    setLocation({ status: "ready", place: payload as PlaceData });
    setHoveredHour(null);
    setDisplayedHour(0);
    setHoveredHour(null);
    setQuery("");
  }

  async function loadPlaceByCoordinates(latitude: number, longitude: number) {
    setLocation((current) => ({
      status: "loading",
      place: "place" in current ? current.place : activePlace,
    }));

    const response = await fetch(
      `/api/location?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`,
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Could not find this location.");
    }

    setLocation({ status: "ready", place: payload as PlaceData });
    setHoveredHour(null);
    setDisplayedHour(0);
    setHoveredHour(null);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loadPlaceByQuery(query).catch((error: Error) =>
      setLocation({ status: "error", message: error.message, place: activePlace }),
    );
    closeSearch();
  }

  function requestLocation() {
    if (!("geolocation" in navigator)) {
      setLocation({
        status: "error",
        message: "Location is not available in this browser.",
        place: activePlace,
      });
      return;
    }

    setLocation({ status: "locating", place: activePlace });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        loadPlaceByCoordinates(
          position.coords.latitude,
          position.coords.longitude,
        ).catch((error: Error) =>
          setLocation({
            status: "error",
            message: error.message,
            place: activePlace,
          }),
        );
      },
      () =>
        setLocation({
          status: "error",
          message: "Location permission was blocked.",
          place: activePlace,
        }),
      {
        enableHighAccuracy: true,
        maximumAge: 10 * 60 * 1000,
        timeout: 10_000,
      },
    );
  }

  return (
    <>
      {!hasEntered ? (
        <div className="relative flex h-dvh items-center justify-center overflow-hidden">
          <div
            className="sky-gradient pointer-events-none absolute inset-0"
            style={{
              backgroundImage: "linear-gradient(180deg, #4a7ab8 0%, #6a9ad4 32%, #9ac0e8 60%, #f0b858 100%)",
            }}
          />
          <div className="sky-linear-light pointer-events-none absolute inset-0" />
          <div className="sky-linear-haze pointer-events-none absolute inset-x-[-18%] bottom-[-18%] h-[58vh]" />
          <div className="relative z-10 flex w-full max-w-[18.5rem] flex-col items-center gap-3 px-5 text-center sm:max-w-none sm:px-0">
            <h1 className="text-[22px] font-medium leading-[1.08] tracking-tight text-white/90 sm:text-2xl sm:leading-none">
              <span className="block whitespace-nowrap sm:hidden">a visual exploration</span>
              <span className="block whitespace-nowrap sm:hidden">with weather and gradients</span>
              <span className="hidden sm:inline">a visual exploration with weather and gradients</span>
            </h1>
            <div className="flex flex-col items-center gap-3 text-sm sm:flex-row sm:gap-6">
              <button
                className="text-white/75 underline underline-offset-4 transition hover:text-white"
                onClick={handleLocationAllow}
                type="button"
              >
                allow location
              </button>
              <button
                className="text-white/75 underline underline-offset-4 transition hover:text-white"
                onClick={handleLocationDeny}
                type="button"
              >
                use default
              </button>
            </div>
          </div>
        </div>
      ) : !defaultPlaceLoaded ? (
        <div className="relative flex h-dvh items-center justify-center overflow-hidden">
          <div
            className="sky-gradient pointer-events-none absolute inset-0"
            style={{ backgroundImage: "linear-gradient(180deg, #0a0e24 0%, #141832 32%, #242852 64%, #3a3e66 100%)" }}
          />
          <div className="sky-linear-light pointer-events-none absolute inset-0" />
          <div className="sky-linear-haze pointer-events-none absolute inset-x-[-18%] bottom-[-18%] h-[58vh]" />
          <div className="relative z-10 flex flex-col items-center gap-3 text-white/85">
            <span className="text-sm tracking-wide">Loading Funchal weather</span>
          </div>
        </div>
      ) : (
        <main className="relative flex h-dvh items-center justify-center overflow-hidden px-5 py-12 text-center">
          <div
            className="sky-gradient pointer-events-none absolute inset-0"
            style={{ backgroundImage: sky.background }}
          />
        {fadingBg && (
          <div
            className="pointer-events-none absolute inset-0 blur-[2px] transition-opacity duration-[1400ms] ease-out sm:blur-[6px]"
            style={{
              backgroundImage: fadingBg,
              backgroundSize: "100% 145%",
              opacity: fadeOut ? 0 : 1,
              transform: "scale(1.01)",
            }}
            onTransitionEnd={() => { setFadingBg(null); setFadeOut(false); }}
          />
        )}
        <div className="sky-linear-light pointer-events-none absolute inset-0" />
        <div className="sky-linear-haze pointer-events-none absolute inset-x-[-18%] bottom-[-18%] h-[58vh]" />

      <div
        ref={searchRef}
        className="fixed left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 transform-gpu overflow-hidden rounded-full border border-white/14 bg-white/12 transition-[width] duration-150 ease-out sm:top-8 sm:-translate-y-0 sm:-translate-x-1/2 sm:bg-white/10 sm:backdrop-blur-xl sm:duration-[400ms]"
        style={{ width: searchOpen ? "min(82vw, 24rem)" : `min(calc(100vw - 2rem), ${compactSearchWidth + 40}px)` }}
      >
        {/* Compact view — shows city name */}
          <div
            className="flex h-10 cursor-pointer items-center justify-center px-5 text-sm text-white/92 transition-[opacity,transform] duration-150 ease-out sm:duration-300"
            style={{
              opacity: searchOpen ? 0 : 1,
              pointerEvents: searchOpen ? "none" : "auto",
              transform: searchOpen ? "translateY(4px)" : "translateY(0px)",
              whiteSpace: "nowrap",
            }}
            onClick={openSearch}
        >
          <span ref={compactSearchMeasureRef} className="inline-block whitespace-nowrap">{placeLabel}</span>
        </div>

        {/* Expanded view — search form */}
        <form
          className="absolute inset-0 flex items-center gap-2 px-4 transition-[opacity,transform] duration-150 ease-out sm:duration-300"
          style={{
            opacity: searchOpen ? 1 : 0,
            pointerEvents: searchOpen ? "auto" : "none",
            transform: searchOpen ? "translateY(0px)" : "translateY(-4px)",
            whiteSpace: "nowrap",
          }}
          onSubmit={handleSearch}
        >
          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-white/95">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true" className="shrink-0"><path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path></svg>
            <input
              ref={searchInputRef}
              className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-white/62"
              disabled={isBusy}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchHasTyped(true);
              }}
              placeholder="Search city"
              type="search"
              value={query}
            />
          </label>
          <button
            aria-label="Use my location"
            className="flex shrink-0 items-center justify-center text-sm text-white/95 transition hover:text-white disabled:cursor-wait disabled:opacity-60"
            disabled={isBusy}
            type="button"
            onClick={() => { requestLocation(); closeSearch(); }}
          >
            {location.status === "locating" ? (
              "…"
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M240,120H215.63A88.13,88.13,0,0,0,136,40.37V16a8,8,0,0,0-16,0V40.37A88.13,88.13,0,0,0,40.37,120H16a8,8,0,0,0,0,16H40.37A88.13,88.13,0,0,0,120,215.63V240a8,8,0,0,0,16,0V215.63A88.13,88.13,0,0,0,215.63,136H240a8,8,0,0,0,0-16ZM128,200a72,72,0,1,1,72-72A72.08,72.08,0,0,1,128,200Zm0-112a40,40,0,1,0,40,40A40,40,0,0,0,128,88Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,152Z"></path></svg>
            )}
          </button>
        </form>
      </div>

      <aside
        className="fixed right-8 top-8 z-20 flex flex-col items-end gap-3 text-white"
      >
        <Stat label="Temp" value={`${Math.round(activeWeather.temperature)}°C`} />
        <Stat label="Rain" value={`${activeWeather.rain.toFixed(1)} mm`} />
        <Stat label="Wind" value={formatSpeed(activeWeather.windSpeed)} />
        <Stat label="Gust" value={formatSpeed(activeWeather.windGusts)} />
        <Stat label="Sky" value={getWeatherLabel(activeWeather.code)} />
        {location.status === "error" ? (
          <p className="text-sm text-white/75">{location.message}</p>
        ) : null}
      </aside>

      <div
        className="fixed left-8 top-8 z-20 flex flex-col items-start text-white"
      >
        <span className="text-[14px] text-white/60">{date}</span>
        <span className="font-mono text-[14px] text-white/60">
          {formatForecastTime(activeWeather.time)}
        </span>
      </div>

      <section
        className="fixed inset-x-8 bottom-8 z-20 mx-auto max-w-4xl px-5 py-4 text-white select-none"
      >
        <div className="flex justify-center">
        <div
          ref={timelineRef}
          className="inline-flex h-24 cursor-pointer items-end gap-[3px] sm:gap-1"
          style={{ touchAction: "pan-y" }}
          onMouseLeave={() => {
            setHoveredHour(null);
            setTouchTooltipVisible(false);
          }}
          onMouseMove={(e) => {
            setTouchTooltipVisible(false);
            updateTimelineInteraction(e.clientX, timelineDragging);
            if (!timelineDragging) return;
          }}
          onMouseUp={() => setTimelineDragging(false)}
          onTouchEnd={() => {
            setTimelineDragging(false);
            scheduleTouchTooltipHide();
          }}
          onTouchCancel={() => {
            setTimelineDragging(false);
            setTouchTooltipVisible(false);
            setHoveredHour(null);
          }}
          onTouchMove={(e) => {
            const touch = e.touches[0];
            if (!touch) return;
            showTouchTooltip();
            updateTimelineInteraction(touch.clientX, true);
          }}
        >
            {hourlyForecast.map((hour, index) => {
              const visualHour = hoveredHour !== null ? hoveredHour : displayedHour;
              const tickHeight = getTimelineTickHeight(index, visualHour);
              const tickOpacity = getTimelineTickOpacity(index, visualHour);

              return (
                <button
                  ref={(node) => {
                    timelineTickRefs.current[index] = node;
                  }}
                  aria-label={`${formatForecastTime(hour.time)}: ${Math.round(hour.temperature)} degrees, ${getWeatherLabel(
                    hour.code,
                  )}`}
                  className="timeline-tick group relative -mx-1 flex h-20 w-[16px] items-end justify-center sm:-mx-1.5 sm:w-[20px]"
                  key={`${hour.time}-${index}`}
                  onBlur={() => setHoveredHour(null)}
                  onFocus={() => {
                    setTouchTooltipVisible(false);
                    setHoveredHour(index);
                  }}
                  onMouseEnter={() => {
                    setTouchTooltipVisible(false);
                    setHoveredHour(index);
                  }}
                  onMouseDown={() => {
                    setTouchTooltipVisible(false);
                    setTimelineDragging(true);
                    setHoveredHour(index);
                    setDisplayedHour(index);
                  }}
                  onClick={() => { setDisplayedHour(index); }}
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    if (!touch) return;
                    showTouchTooltip();
                    setTimelineDragging(true);
                    updateTimelineInteraction(touch.clientX, true);
                  }}
                  type="button"
                >
                  <span
                    className="block w-px rounded-full bg-white transition-[height,opacity] duration-200"
                    style={{
                      height: `${tickHeight}px`,
                      opacity: tickOpacity,
                    }}
                  />
                  {(hoveredHour !== null || timelineDragging || touchTooltipVisible || touchTooltipFading) && visualHour === index && (
                    <div className={`pointer-events-none absolute bottom-full mb-4 whitespace-nowrap rounded-full border border-white/14 bg-white/10 px-2.5 py-1 font-mono text-[11px] text-white/92 backdrop-blur-md transition-opacity duration-200 sm:backdrop-blur-xl ${touchTooltipFading ? "opacity-0" : "opacity-100"}`}>
                      {formatForecastTime(hour.time)}
                    </div>
                  )}
                </button>
              );
            })}
        </div>
        </div>
      </section>
    </main>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="font-sans text-[14px] tracking-normal text-white/45">
        {label}
      </p>
      <p className="whitespace-nowrap font-mono text-sm font-medium text-white/60">
        {value}
      </p>
    </div>
  );
}

function formatSpeed(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)} km/h`
    : "—";
}

function getTimelineTickHeight(index: number, hoveredHour: number | null) {
  if (hoveredHour === null) {
    return 28;
  }

  const distance = Math.abs(index - hoveredHour);

  if (distance === 0) return 72;
  if (distance === 1) return 48;
  if (distance === 2) return 38;
  if (distance === 3) return 32;

  return 28;
}

function getTimelineTickOpacity(index: number, hoveredHour: number | null) {
  if (hoveredHour === null) {
    return 0.62;
  }

  const distance = Math.abs(index - hoveredHour);

  if (distance === 0) return 0.96;
  if (distance === 1) return 0.88;
  if (distance === 2) return 0.8;
  if (distance === 3) return 0.72;

  return 0.62;
}

type TimeBucket = "night" | "dawn" | "morning" | "noon" | "afternoon" | "evening" | "dusk";
type WeatherCondition = "storm" | "rain" | "fog" | "cloudy" | "clear";

function getTimeBucket(hour: number): TimeBucket {
  if (hour >= 20 || hour < 4) return "night";
  if (hour >= 4 && hour < 6) return "dawn";
  if (hour >= 6 && hour < 9) return "morning";
  if (hour >= 9 && hour < 15) return "noon";
  if (hour >= 15 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 19) return "evening";
  return "dusk";
}

function getWeatherCondition(weather: CurrentWeather): WeatherCondition {
  const code = weather.code;
  if (code >= 95) return "storm";
  if (weather.rain > 0 || weather.precipitation > 0 || rainCodes.has(code)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (weather.cloudCover > 65 || [2, 3].includes(code)) return "cloudy";
  return "clear";
}

const skyGradients: Record<WeatherCondition, Record<TimeBucket, SkyTheme>> = {
  storm: {
    night: skyTheme("#080a18 0%, #1a1a30 28%, #2e1e40 58%, #4a2e50 100%", "bg-[#18122a]/62"),
    dawn: skyTheme("#2a1e38 0%, #4a3048 30%, #6a3e52 60%, #8a4e5a 100%", "bg-[#2e1e3a]/54"),
    morning: skyTheme("#3e2e50 0%, #5e3e60 32%, #7e4e68 64%, #9a5e6e 100%", "bg-[#3e2a48]/50"),
    noon: skyTheme("#4a3e68 0%, #6a4e78 34%, #8a5e80 66%, #a66e88 100%", "bg-[#4a3458]/48"),
    afternoon: skyTheme("#3e3258 0%, #5e4268 32%, #7e5270 64%, #9a6278 100%", "bg-[#3e2e4e]/52"),
    evening: skyTheme("#2e2238 0%, #4e3248 30%, #6e4258 60%, #8a5260 100%", "bg-[#2e1e3a]/58"),
    dusk: skyTheme("#1a1628 0%, #2e2238 28%, #423048 58%, #5e4058 100%", "bg-[#1e1a2e]/60"),
  },
  rain: {
    night: skyTheme("#0a0e1c 0%, #1a1e2e 30%, #2a2e42 62%, #3e4256 100%", "bg-[#121628]/62"),
    dawn: skyTheme("#5a6e82 0%, #7a8a96 32%, #9a9a82 64%, #baa272 100%", "bg-[#4e5e4e]/42"),
    morning: skyTheme("#4e6278 0%, #5e7288 34%, #6e8298 68%, #8a9aaa 100%", "bg-[#3e5268]/42"),
    noon: skyTheme("#5e7288 0%, #6e8298 34%, #7e92a8 68%, #9aaab8 100%", "bg-[#4a6278]/38"),
    afternoon: skyTheme("#4e6278 0%, #5e7288 32%, #6e8298 64%, #8a9aaa 100%", "bg-[#3e5268]/40"),
    evening: skyTheme("#2e3e52 0%, #3e4e62 34%, #4e5e72 66%, #6a7a8a 100%", "bg-[#263242]/50"),
    dusk: skyTheme("#1e2a3e 0%, #2e3a4e 32%, #3e4a5e 64%, #5a6678 100%", "bg-[#1e2a3a]/52"),
  },
  fog: {
    night: skyTheme("#1a1e26 0%, #262e38 32%, #363e4a 64%, #4a525e 100%", "bg-[#1e262e]/60"),
    dawn: skyTheme("#8a9a9a 0%, #a2b0a6 32%, #c2c896 64%, #d8c07e 100%", "bg-[#6e7e5e]/28"),
    morning: skyTheme("#6e828a 0%, #7a929a 34%, #8aa2aa 68%, #a6b6be 100%", "bg-[#5a6e76]/30"),
    noon: skyTheme("#7a8e96 0%, #8a9ea6 34%, #9aaeb6 68%, #b6c6ce 100%", "bg-[#627a82]/26"),
    afternoon: skyTheme("#6e828a 0%, #7a929a 32%, #8aa2aa 64%, #a6b6be 100%", "bg-[#5a6e76]/30"),
    evening: skyTheme("#4e5e66 0%, #5e6e76 34%, #6e7e86 66%, #8a9a9e 100%", "bg-[#42525a]/42"),
    dusk: skyTheme("#4a5660 0%, #5e6670 32%, #727680 64%, #8a8e8e 100%", "bg-[#424a4e]/40"),
  },
  cloudy: {
    night: skyTheme("#161a28 0%, #222a3a 30%, #323a4e 62%, #464e62 100%", "bg-[#181e2e]/60"),
    dawn: skyTheme("#6e7e8e 0%, #8a9a92 28%, #b2b08a 56%, #d4b87a 100%", "bg-[#5e6e4e]/32"),
    morning: skyTheme("#6e8296 0%, #7e92a6 34%, #8ea2b6 68%, #aab8ca 100%", "bg-[#5e728a]/30"),
    noon: skyTheme("#7e92a6 0%, #8ea2b6 34%, #9eb2c6 68%, #bac8da 100%", "bg-[#66829a]/26"),
    afternoon: skyTheme("#6e8296 0%, #7e92a6 32%, #8ea2b6 60%, #c4b8a0 100%", "bg-[#5e728a]/30"),
    evening: skyTheme("#4e5e72 0%, #5e6e82 34%, #6e7e92 66%, #9a8e82 100%", "bg-[#42526a]/42"),
    dusk: skyTheme("#2e2a3e 0%, #4a4a5e 25%, #6e5e68 50%, #9a7a62 75%, #b8a078 100%", "bg-[#2e2a3a]/48"),
  },
  clear: {
    night: skyTheme("#0a0e24 0%, #141832 32%, #242852 64%, #3a3e66 100%", "bg-[#121630]/58"),
    dawn: skyTheme("#5e7e9e 0%, #8ab0c8 28%, #d8c8a0 56%, #f0a880 100%", "bg-[#7e6e4e]/26"),
    morning: skyTheme("#4e8ec6 0%, #6eaad6 34%, #8ec4e6 68%, #b2d8f0 100%", "bg-[#3e6e96]/22"),
    noon: skyTheme("#3e8ec6 0%, #5eaad6 34%, #7ec4e6 68%, #a2d8f0 100%", "bg-[#2e6e96]/18"),
    afternoon: skyTheme("#4a7ab8 0%, #6a9ad4 32%, #9ac0e8 60%, #f0b858 100%", "bg-[#4e6e8e]/24"),
    evening: skyTheme("#3e5e8e 0%, #5e7ea8 30%, #8a9eb8 58%, #d8a880 100%", "bg-[#2e4e6e]/30"),
    dusk: skyTheme("#18152d 0%, #35264e 24%, #6f4c6a 48%, #b86f5f 74%, #d79867 100%", "bg-[#261f30]/50"),
  },
};

const hotClearGradients: Record<TimeBucket, SkyTheme> = {
  night: skyTheme("#1a162e 0%, #2e243e 32%, #42324e 64%, #56405e 100%", "bg-[#241e36]/56"),
  dawn: skyTheme("#4a7e9e 0%, #7a9eb6 28%, #b0bea0 56%, #e0c870 100%", "bg-[#6e7e4e]/24"),
  morning: skyTheme("#3e7eae 0%, #6e9ec6 34%, #9abea6 68%, #c8d88a 100%", "bg-[#4e6e3e]/22"),
  noon: skyTheme("#3e7eb6 0%, #5e9ec6 34%, #82b6d0 68%, #a8d0e0 100%", "bg-[#2e6e96]/18"),
  afternoon: skyTheme("#3e72a6 0%, #5e92be 32%, #7eaeb0 60%, #c0c88a 100%", "bg-[#3e5e4e]/22"),
  evening: skyTheme("#3e5e8e 0%, #5e7ea8 30%, #7a9e9e 58%, #b0b86e 100%", "bg-[#2e4e3e]/28"),
  dusk: skyTheme("#1a1e3e 0%, #3a4e6e 25%, #5e7e8e 50%, #9a9e6e 75%, #c8b84e 100%", "bg-[#2e2e3e]/48"),
};

const coldClearGradients: Record<TimeBucket, SkyTheme> = {
  night: skyTheme("#0a0e2e 0%, #141e42 32%, #24325e 64%, #3a4678 100%", "bg-[#121e3a]/60"),
  dawn: skyTheme("#3e5e7e 0%, #5e7e9e 28%, #7e9ebe 56%, #9ebee0 100%", "bg-[#2e4e6e]/28"),
  morning: skyTheme("#3e6e9e 0%, #5e8ebe 34%, #7eaece 68%, #9ecede 100%", "bg-[#2e5e7e]/24"),
  noon: skyTheme("#2e6e9e 0%, #4e8ebe 34%, #6eaece 68%, #8ecede 100%", "bg-[#1e4e6e]/20"),
  afternoon: skyTheme("#3e5e8e 0%, #5e7eae 32%, #7e9ebe 60%, #9ebee0 100%", "bg-[#2e4e6e]/24"),
  evening: skyTheme("#2e4e6e 0%, #4e6e8e 30%, #6e8eae 58%, #8eaed0 100%", "bg-[#1e3e5e]/30"),
  dusk: skyTheme("#0a1e3e 0%, #1e3e5e 25%, #3e5e7e 50%, #5e7e9e 75%, #7e9ebe 100%", "bg-[#0e2e4e]/52"),
};

function getSkyTheme(weather: CurrentWeather): SkyTheme {
  const hour = getLocalHour(weather.time);
  const timeBucket = getTimeBucket(hour);
  const condition = getWeatherCondition(weather);
  const temp = weather.temperature;

  // Temperature overrides for clear skies
  if (condition === "clear" && temp >= 32) {
    return hotClearGradients[timeBucket];
  }
  if (condition === "clear" && temp <= 5) {
    return coldClearGradients[timeBucket];
  }

  return skyGradients[condition][timeBucket];
}

function buildFallbackHourlyForecast(baseTime: string): CurrentWeather[] {
  const start = parseLocalWeatherTime(baseTime);
  const startDate = start
    ? new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute))
    : new Date(`${baseTime}:00Z`);

  return Array.from({ length: 24 }, (_, index) => {
    const time = new Date(startDate.getTime() + index * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
    const hour = ((start?.hour ?? 0) + index) % 24;
    const daytime = hour >= 6 && hour < 18;

    return {
      time,
      isDay: daytime,
      temperature: daytime ? 16 + Math.round(index * 0.6) : 12 + Math.round(index * 0.2),
      code: daytime ? 1 : 45,
      cloudCover: daytime ? 38 : 78,
      precipitation: 0,
      rain: 0,
      windSpeed: 8 + (index % 5),
      windGusts: 16 + (index % 7),
      windDirection: 80,
    };
  });
}

function parseLocalWeatherTime(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
}

function getLocalHour(value: string) {
  return parseLocalWeatherTime(value)?.hour ?? 12;
}

function formatWeatherDate(value: string) {
  const parts = parseLocalWeatherTime(value);
  const date = parts
    ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute))
    : new Date(value);

  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatForecastTime(value: string | undefined) {
  if (!value) {
    return "—";
  }

  const parts = parseLocalWeatherTime(value);
  const date = parts
    ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute))
    : new Date(value);

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date);
}

function skyTheme(stops: string, panel: string): SkyTheme {
  return {
    background: `linear-gradient(180deg, ${stops})`,
    panelClass: panel,
    textClass: "text-white drop-shadow-[0_18px_54px_rgba(17,22,35,0.32)]",
  };
}

function getWeatherLabel(code: number) {
  return weatherLabels.get(code) ?? "Sky";
}

const weatherLabels = new Map<number, string>([
  [0, "Clear"],
  [1, "Mostly clear"],
  [2, "Clouds"],
  [3, "Overcast"],
  [45, "Mist"],
  [48, "Fog"],
  [51, "Drizzle"],
  [53, "Drizzle"],
  [55, "Drizzle"],
  [61, "Rain"],
  [63, "Rain"],
  [65, "Heavy rain"],
  [80, "Showers"],
  [81, "Showers"],
  [82, "Heavy showers"],
  [95, "Thunder"],
]);

const rainCodes = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);
