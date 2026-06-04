import { NextResponse } from "next/server";

type NominatimAddress = {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  island?: string;
  archipelago?: string;
  country?: string;
};

type NominatimResponse = {
  display_name?: string;
  address?: NominatimAddress;
};

type NominatimSearchResponse = Array<{
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  address?: NominatimAddress;
}>;

type GeocodingResponse = {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
    admin2?: string;
    admin3?: string;
    timezone?: string;
  }>;
};

type OpenMeteoResponse = {
  timezone: string;
  current: {
    time: string;
    is_day: number;
    temperature_2m: number;
    weather_code: number;
    cloud_cover: number;
    precipitation: number;
    rain: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    wind_direction_10m: number;
  };
  hourly: {
    time: string[];
    is_day: number[];
    temperature_2m: number[];
    weather_code: number[];
    cloud_cover: number[];
    precipitation: number[];
    rain: number[];
    wind_speed_10m: number[];
    wind_gusts_10m: number[];
    wind_direction_10m: number[];
  };
};

type WeatherResponse = OpenMeteoResponse;

type MetNoResponse = {
  properties?: {
    timeseries?: MetNoTimeseriesEntry[];
  };
};

type MetNoTimeseriesEntry = {
  time: string;
  data: {
    instant: {
      details: {
        air_temperature?: number;
        cloud_area_fraction?: number;
        wind_speed?: number;
        wind_from_direction?: number;
      };
    };
    next_1_hours?: {
      summary?: {
        symbol_code?: string;
      };
      details?: {
        precipitation_amount?: number;
      };
    };
  };
};

type Place = {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
};

const APP_USER_AGENT =
  "weather-location-app/0.1 github.com/migueljsleca/weather-gradient";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const latitude = Number(searchParams.get("lat"));
  const longitude = Number(searchParams.get("lon"));

  try {
    const place = query
      ? await getPlaceFromQuery(query)
      : await getPlaceFromCoordinates(latitude, longitude);
    const weather = await getCurrentWeather(
      place.latitude,
      place.longitude,
      place.timezone,
    );

    return NextResponse.json(
      {
        name: place.name,
        country: place.country,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: weather.timezone,
        weather: {
          time: weather.current.time,
          isDay: weather.current.is_day === 1,
          temperature: weather.current.temperature_2m,
          code: weather.current.weather_code,
          cloudCover: weather.current.cloud_cover,
          precipitation: weather.current.precipitation,
          rain: weather.current.rain,
          windSpeed: weather.current.wind_speed_10m,
          windGusts: weather.current.wind_gusts_10m,
          windDirection: weather.current.wind_direction_10m,
        },
        hourly: toHourlyForecast(weather),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
        },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Location data is unavailable right now.";

    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function getPlaceFromQuery(query: string): Promise<Place> {
  const { searchName, qualifier } = splitLocationQuery(query);
  for (const candidate of buildSearchCandidates(searchName, qualifier, query)) {
    const params = new URLSearchParams({
      name: candidate,
      count: "10",
      language: "en",
      format: "json",
    });

    const response = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
        next: {
          revalidate: 60 * 60 * 24 * 7,
        },
      },
      5_000,
    ).catch(() => null);

    if (!response?.ok) {
      continue;
    }

    const data = (await response.json()) as GeocodingResponse;
    const result = chooseGeocodingResult(data.results ?? [], qualifier);

    if (result) {
      return {
        name: result.name,
        country: result.country ?? result.admin1,
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone,
      };
    }
  }

  const fallback = await getPlaceFromNominatimQuery(query);

  if (fallback) {
    return fallback;
  }

  throw new Error("I could not find that location.");
}

function splitLocationQuery(query: string) {
  const [name, ...rest] = query.split(",");
  const explicitSearchName = name.trim() || query.trim();
  const explicitQualifier = rest.join(" ").trim();

  if (explicitQualifier) {
    return { searchName: explicitSearchName, qualifier: explicitQualifier };
  }

  const normalizedQuery = normalizeLocationText(query);
  const inferredQualifier = getInferredQualifier(normalizedQuery);

  if (!inferredQualifier) {
    return { searchName: explicitSearchName, qualifier: "" };
  }

  const searchName = query
    .replace(new RegExp(inferredQualifier.pattern, "i"), "")
    .replace(/\s+/g, " ")
    .trim();

  return { searchName: searchName || explicitSearchName, qualifier: inferredQualifier.value };
}

function buildSearchCandidates(searchName: string, qualifier: string, query: string) {
  const candidates = new Set<string>();

  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      candidates.add(trimmed);
    }
  };

  add(query);
  add(searchName);

  if (qualifier) {
    add(`${searchName} ${qualifier}`);
    add(`${searchName}, ${qualifier}`);

    for (const variant of buildQualifierVariants(qualifier)) {
      add(`${searchName} ${variant}`);
      add(`${variant} ${searchName}`);
    }
  }

  add(normalizeLocationText(query));

  return [...candidates];
}

function chooseGeocodingResult(
  results: NonNullable<GeocodingResponse["results"]>,
  qualifier: string,
) {
  if (!qualifier) {
    return results[0];
  }

  const qualifierVariants = buildQualifierVariants(qualifier);

  return (
    results.find((result) => {
      const candidate = [
        result.name,
        result.country,
        result.admin1,
        result.admin2,
        result.admin3,
        result.timezone,
      ]
        .filter(Boolean)
        .map((value) => normalizeLocationText(String(value)))
        .join(" ");

      return qualifierVariants.some((variant) => candidate.includes(variant));
    })
  );
}

function getInferredQualifier(normalizedQuery: string) {
  if (/\b(acores|azores)\b/.test(normalizedQuery)) {
    return { pattern: "açores|acores|azores", value: "Açores" };
  }

  return null;
}

async function getPlaceFromNominatimQuery(query: string): Promise<Place | null> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
  });

  const response = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT,
      },
      next: {
        revalidate: 60 * 60 * 24 * 7,
      },
    },
    5_000,
  ).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const data = (await response.json()) as NominatimSearchResponse;

  const result = data.find((candidate) => {
    const latitude = Number(candidate.lat);
    const longitude = Number(candidate.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude);
  });

  if (!result) {
    return null;
  }

  const address = result.address ?? {};

  return {
    name:
      address.city ??
      address.town ??
      address.village ??
      address.municipality ??
      address.county ??
      address.island ??
      result.name ??
      result.display_name ??
      query,
    country: address.country ?? address.archipelago,
    latitude: Number(result.lat),
    longitude: Number(result.lon),
  };
}

async function getPlaceFromCoordinates(
  latitude: number,
  longitude: number,
): Promise<Place> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Latitude and longitude are required.");
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("Coordinates are outside the valid range.");
  }

  const params = new URLSearchParams({
    format: "jsonv2",
    lat: latitude.toString(),
    lon: longitude.toString(),
    zoom: "10",
    addressdetails: "1",
  });

  const response = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT,
      },
      next: {
        revalidate: 60 * 60 * 24,
      },
    },
    5_000,
  );

  if (!response.ok) {
    throw new Error("Reverse geocoding failed.");
  }

  const data = (await response.json()) as NominatimResponse;
  const address = data.address ?? {};
  const name =
    address.city ??
    address.town ??
    address.village ??
    address.municipality ??
    address.county ??
    address.island ??
    address.state ??
    address.country ??
    data.display_name ??
    `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;

  return {
    name,
    country: address.country,
    latitude,
    longitude,
  };
}

async function getCurrentWeather(
  latitude: number,
  longitude: number,
  timezone?: string,
): Promise<WeatherResponse> {
  try {
    return await Promise.any([
      getOpenMeteoWeather(latitude, longitude),
      getMetNoWeather(latitude, longitude, timezone),
    ]);
  } catch {
    throw new Error("Weather data is unavailable right now.");
  }
}

async function getOpenMeteoWeather(
  latitude: number,
  longitude: number,
): Promise<OpenMeteoResponse> {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    current:
      "is_day,temperature_2m,weather_code,cloud_cover,precipitation,rain,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
    hourly:
      "is_day,temperature_2m,weather_code,cloud_cover,precipitation,rain,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
    timezone: "auto",
    wind_speed_unit: "kmh",
    forecast_days: "2",
  });

  const response = await fetchWithTimeout(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    },
    6_000,
  );

  if (!response.ok) {
    throw new Error("Weather lookup failed.");
  }

  return (await response.json()) as OpenMeteoResponse;
}

async function getMetNoWeather(
  latitude: number,
  longitude: number,
  timezone = "UTC",
): Promise<WeatherResponse> {
  const params = new URLSearchParams({
    lat: latitude.toFixed(4),
    lon: longitude.toFixed(4),
  });

  const response = await fetchWithTimeout(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?${params.toString()}`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT,
      },
    },
    6_000,
  );

  if (!response.ok) {
    throw new Error("Backup weather lookup failed.");
  }

  const data = (await response.json()) as MetNoResponse;
  const hourly = (data.properties?.timeseries ?? [])
    .map((entry) => toMetNoHour(entry, timezone))
    .filter((hour): hour is OpenMeteoResponse["current"] => Boolean(hour))
    .slice(0, 24);

  const current = hourly[0];

  if (!current) {
    throw new Error("Backup weather data is incomplete.");
  }

  return {
    timezone,
    current,
    hourly: {
      time: hourly.map((hour) => hour.time),
      is_day: hourly.map((hour) => hour.is_day),
      temperature_2m: hourly.map((hour) => hour.temperature_2m),
      weather_code: hourly.map((hour) => hour.weather_code),
      cloud_cover: hourly.map((hour) => hour.cloud_cover),
      precipitation: hourly.map((hour) => hour.precipitation),
      rain: hourly.map((hour) => hour.rain),
      wind_speed_10m: hourly.map((hour) => hour.wind_speed_10m),
      wind_gusts_10m: hourly.map((hour) => hour.wind_gusts_10m),
      wind_direction_10m: hourly.map((hour) => hour.wind_direction_10m),
    },
  };
}

function toMetNoHour(entry: MetNoTimeseriesEntry, timezone: string) {
  const details = entry.data.instant.details;
  const temperature = details.air_temperature;

  if (typeof temperature !== "number") {
    return null;
  }

  const symbol = entry.data.next_1_hours?.summary?.symbol_code;
  const precipitation = entry.data.next_1_hours?.details?.precipitation_amount ?? 0;
  const windSpeed = typeof details.wind_speed === "number" ? details.wind_speed * 3.6 : 0;

  return {
    time: formatInTimeZone(entry.time, timezone),
    is_day: symbol?.includes("night") ? 0 : 1,
    temperature_2m: temperature,
    weather_code: getWmoCodeFromMetNoSymbol(symbol, precipitation),
    cloud_cover: details.cloud_area_fraction ?? 0,
    precipitation,
    rain: precipitation,
    wind_speed_10m: windSpeed,
    wind_gusts_10m: windSpeed,
    wind_direction_10m: details.wind_from_direction ?? 0,
  };
}

function getWmoCodeFromMetNoSymbol(symbol: string | undefined, precipitation: number) {
  if (!symbol) {
    return precipitation > 0 ? 61 : 3;
  }

  if (symbol.includes("thunder")) return 95;
  if (symbol.includes("heavyrain")) return 65;
  if (symbol.includes("rainshowers")) return 80;
  if (symbol.includes("rain")) return 61;
  if (symbol.includes("sleet") || symbol.includes("snow")) return 61;
  if (symbol.includes("fog")) return 45;
  if (symbol.includes("cloudy")) return symbol.includes("partly") ? 2 : 3;
  if (symbol.includes("fair")) return 1;
  if (symbol.includes("clearsky")) return 0;
  return precipitation > 0 ? 61 : 3;
}

function formatInTimeZone(value: string, timezone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.replace(/:00Z$/, "");
  }

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);

    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = part("hour");
    const minute = part("minute");

    if (!year || !month || !day || !hour || !minute) {
      return value.replace(/:00Z$/, "");
    }

    return `${year}-${month}-${day}T${hour}:${minute}`;
  } catch {
    return value.replace(/:00Z$/, "");
  }
}

function normalizeLocationText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildQualifierVariants(qualifier: string) {
  const base = normalizeLocationText(qualifier);
  const variants = new Set([base]);

  for (const [from, to] of [
    ["acores", "azores"],
    ["azores", "acores"],
  ] as const) {
    if (base.includes(from)) {
      variants.add(base.replaceAll(from, to));
    }
  }

  return [...variants];
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

function toHourlyForecast(weather: OpenMeteoResponse) {
  const currentHour = `${weather.current.time.slice(0, 13)}:00`;
  const currentIndex = weather.hourly.time.findIndex((time) => time >= currentHour);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;

  return weather.hourly.time.slice(startIndex, startIndex + 24).map((time, index) => {
    const sourceIndex = startIndex + index;

    return {
      time,
      isDay: weather.hourly.is_day[sourceIndex] === 1,
      temperature: weather.hourly.temperature_2m[sourceIndex],
      code: weather.hourly.weather_code[sourceIndex],
      cloudCover: weather.hourly.cloud_cover[sourceIndex],
      precipitation: weather.hourly.precipitation[sourceIndex],
      rain: weather.hourly.rain[sourceIndex],
      windSpeed: weather.hourly.wind_speed_10m[sourceIndex],
      windGusts: weather.hourly.wind_gusts_10m[sourceIndex],
      windDirection: weather.hourly.wind_direction_10m[sourceIndex],
    };
  });
}
