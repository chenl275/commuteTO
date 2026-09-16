"""Heavy-rail kinematic train model for estimating slow-zone delay.

Used as the physics-based fallback whenever live GTFS-Realtime transponder
data isn't available for a station on the route (see gtfs_service.py and
traffic_service.py) — and as the baseline per-zone delay estimate shown to
riders regardless of telemetry source.
"""

from __future__ import annotations

# 6-car Toronto Rocket.
TRAIN_LENGTH_METERS = 140.0
# Civil (passenger-comfort) braking/acceleration rates used for TTC subway
# speed-restriction timetabling.
BRAKING_DECELERATION_MPS2 = 0.85
TRACTIVE_ACCELERATION_MPS2 = 0.75


def estimate_slow_zone_delay_seconds(
    defect_length_meters: float, reduced_speed_kmh: float, normal_speed_kmh: float
) -> float:
    """Extra time (seconds) a train loses crawling through a reduced-speed
    zone, versus running it at normal operating speed.

    Two components:
      - Cruising loss: the defect zone extended by the train's own length
        (the rear car must also clear it before normal speed resumes),
        crossed at reduced speed instead of normal speed.
      - Transition-ramp loss: the extra time cost of decelerating into and
        re-accelerating out of the restriction, versus an (unrealistic)
        instantaneous speed change.
    """
    if reduced_speed_kmh <= 0 or normal_speed_kmh <= 0:
        return 0.0

    reduced_mps = reduced_speed_kmh / 3.6
    normal_mps = normal_speed_kmh / 3.6

    effective_length_m = defect_length_meters + TRAIN_LENGTH_METERS
    cruise_loss_s = effective_length_m * (1 / reduced_mps - 1 / normal_mps)

    delta_v_mps = normal_mps - reduced_mps
    transition_loss_s = delta_v_mps / (2 * BRAKING_DECELERATION_MPS2) + delta_v_mps / (
        2 * TRACTIVE_ACCELERATION_MPS2
    )

    return cruise_loss_s + transition_loss_s
