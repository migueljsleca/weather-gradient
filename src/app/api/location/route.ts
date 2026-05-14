import { NextResponse } from "next/server";

type NominatimAddress = {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  island?: string;
  country?: string;
};

type NominatimResponse = {
  display_name?: string;
  address?: NominatimAddress;
};

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
  const params = new URLSearchParams({
    name: searchName,
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

  if (!result) {
    throw new Error("I could not find that location.");
  }

  return {
    name: result.name,
    country: result.country ?? result.admin1,
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

function splitLocationQuery(query: string) {
  const [name, ...rest] = query.split(",");
  const searchName = name.trim() || query.trim();
  const qualifier = rest.join(" ").trim().toLowerCase();

  return { searchName, qualifier };
}

function chooseGeocodingResult(
  results: NonNullable<GeocodingResponse["results"]>,
  qualifier: string,
) {
  if (!qualifier) {
    return results[0];
  }

  return (
    results.find((result) =>
      [
        result.country,
        result.admin1,
        result.admin2,
        result.admin3,
        result.timezone,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(qualifier),
    ) ?? results[0]
  );
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
  const currentDate = new Date(weather.current.time);
  currentDate.setMinutes(0, 0, 0);
  const currentMs = currentDate.getTime();
  const currentIndex = weather.hourly.time.findIndex(
    (time) => new Date(time).getTime() >= currentMs,
  );
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
