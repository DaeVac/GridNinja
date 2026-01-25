# apps/backend/app/services/carbon_service.py
"""
carbon_service.py

Purpose:
  Simulates a deterministic Grid Carbon Intensity signal (gCO2e/kWh) and Pricing ($/kWh).
  Used for "Clean Shifting" logic in the compare service.

Math/Sim:
  - **Intensity**: Sinusoidal daily curve (lowest at 3am, highest at 6pm).
  - **Pricing**: Time-of-Use (TOU) step function + noise.

Units:
  - **Carbon Intensity**: grams CO2 equivalent per kWh (g/kWh)
  - **Price**: USD per kWh ($/kWh)

Future Work:
  - Replace `random.uniform` and `math.sin` with live API calls to WattTime or ElectricityMaps.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import datetime


@dataclass
class CarbonConfig:
    # Typical carbon intensity range in many regions: 200–700 gCO2e/kWh
    base_g_per_kwh: float = 450.0
    daily_amp: float = 90.0        # day/night variation amplitude
    noise_amp: float = 15.0        # random noise

    # Electricity price model ($/kWh)
    base_price_usd_per_kwh: float = 0.11
    peak_price_usd_per_kwh: float = 0.18

    # Peak window (local time)
    peak_start_hour: int = 16
    peak_end_hour: int = 21

    seed: int = 7


class CarbonService:
    """
    Provides carbon intensity (g/kWh) and electricity price ($/kWh).
    In production you'd call a real API (WattTime, electricityMaps, ISO feeds).
    For hackathon: deterministic plausible signal.
    """

    def __init__(self, cfg: CarbonConfig | None = None):
        self.cfg = cfg or CarbonConfig()
        random.seed(self.cfg.seed)

    def get_intensity_g_per_kwh(self, ts: datetime) -> float:
        """
        Carbon intensity curve:
          higher in evening peak, lower overnight.
        """
        hour = ts.hour + ts.minute / 60.0

        # Map hour -> sinusoid (lowest around ~3am, highest around ~6pm)
        # shift: peak ~18h -> sin peak at ~18 => phase = (hour-12)/24*2π
        phase = (hour - 12.0) / 24.0 * 2.0 * math.pi
        daily = math.sin(phase)  # [-1, 1]

        noise = random.uniform(-1.0, 1.0) * self.cfg.noise_amp

        intensity = self.cfg.base_g_per_kwh + daily * self.cfg.daily_amp + noise
        return float(max(150.0, min(850.0, intensity)))

    def get_price_usd_per_kwh(self, ts: datetime) -> float:
        """
        Simple TOU pricing: higher during peak hours.
        """
        h = ts.hour
        if self.cfg.peak_start_hour <= h < self.cfg.peak_end_hour:
            price = self.cfg.peak_price_usd_per_kwh
        else:
            price = self.cfg.base_price_usd_per_kwh

        # tiny noise to avoid flat lines
        price += random.uniform(-0.003, 0.003)
        return float(max(0.05, min(0.40, price)))
