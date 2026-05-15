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

type Place = {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const latitude = Number(searchParams.get("lat"));
  const longitude = Number(searchParams.get("lon"));

  try {
    const place = query
      ? await getPlaceFromQuery(query)
      : await getPlaceFromCoordinates(latitude, longitude);
    const weather = await getCurrentWeather(place.latitude, place.longitude);

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

    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
        next: {
          revalidate: 60 * 60 * 24 * 7,
        },
      },
    );

    if (!response.ok) {
      throw new Error("Location search failed.");
    }

    const data = (await response.json()) as GeocodingResponse;
    const result = chooseGeocodingResult(data.results ?? [], qualifier);

    if (result) {
      return {
        name: result.name,
        country: result.country ?? result.admin1,
        latitude: result.latitude,
        longitude: result.longitude,
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

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "weather-location-app/0.1",
      },
      next: {
        revalidate: 60 * 60 * 24 * 7,
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const [result] = (await response.json()) as NominatimSearchResponse;

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

  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "weather-location-app/0.1",
      },
      next: {
        revalidate: 60 * 60 * 24,
      },
    },
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

  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
      },
      next: {
        revalidate: 900,
      },
    },
  );

  if (!response.ok) {
    throw new Error("Weather lookup failed.");
  }

  return (await response.json()) as OpenMeteoResponse;
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
