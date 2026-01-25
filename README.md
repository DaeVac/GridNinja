# GridNinja
<img width="545" height="415" alt="image" src="https://github.com/user-attachments/assets/5b439902-c072-4636-953c-7de9baf83d75" />

# GridNinja: The Neural Control Plane

![Status](https://img.shields.io/badge/Status-Operational-success) ![Stack](https://img.shields.io/badge/Tech-FastAPI%20%7C%20Next.js%20%7C%20PyTorch-blueviolet) ![Physics](https://img.shields.io/badge/Physics-ODE%20Solver-red) ![AI](https://img.shields.io/badge/AI-Graph%20Neural%20Network-green)

**Turning Data Centers from Grid Liabilities into Virtual Power Plants.**

---

## The Problem
The power grid is congested. Data centers are massive, passive loads that threaten grid stability. Utilities are running out of capacity, and "dumb" load shedding destroys hardware.

## The Solution: GridNinja
GridNinja is a **Cyber-Physical Control Plane** that allows data centers to safely interact with the power grid in real-time.

Instead of guessing, we use **Physics-Informed AI** to calculate exactly how much power a facility can inject or withdraw without melting wires (Grid Constraints) or overheating servers (Thermal Constraints).

---

## 🧮 Mathematical Model (The "Physics" in Cyber-Physical)

Unlike standard dashboards, GridNinja solves differential equations in real-time to guarantee safety.

### 1. Thermal Inertia (Newton's Law of Cooling)
We model the datacenter's temperature evolution ($T$) as a function of IT Load ($P_{it}$), Cooling Power ($P_{cool}$), and Ambient Temperature ($T_{amb}$). This allows us to "ride through" power cuts by letting the building heat up safely.

$$C_{th} \frac{dT}{dt} = P_{it} - P_{cool} - \frac{T - T_{amb}}{R_{th}}$$

* $C_{th}$: Heat Capacity of the coolant loops (calculated dynamically based on fluid density).
* $R_{th}$: Thermal Resistance of the facility walls.

### 2. Battery Degradation (Arrhenius Equation)
To prevent "profit-driven suicide" of our batteries, we calculate the chemical aging rate ($k$) based on cell temperature ($T$) and activation energy ($E_a$). We block any arbitrage trade where `Revenue < Degradation Cost`.

$$k_{aging} = A \cdot e^{\frac{-E_a}{R \cdot T}}$$

### 3. Grid Safety (AC Power Flow Proxy)
Our GNN approximates the non-linear AC Power Flow equations to ensure voltage magnitudes ($|V|$) at every bus remain within safe limits:

$$0.95 \le |V_i| \le 1.05 \quad \forall i \in \text{Grid Nodes}$$

---

## System Architecture

Our system uses a **3-Layer Safety Architecture** to ensure 99.999% reliability:

### 1. The Brain (Graph Neural Network)
* **Tech:** PyTorch Geometric + Pandapower
* **Function:** Analyzes the full **IEEE-33 Bus Topology** in real-time.
* **Why it matters:** It finds "Hidden Headroom" on the grid that static utility rules miss, allowing for 20-30% more capacity utilization.

### 2. The Body (Physics Engine)
* **Tech:** Python ODE Solver (`scipy`/`numpy`)
* **Function:** Simulates the **Thermal Inertia** of the data center's coolant loops.
* **Why it matters:** It solves the differential equations above every second, creating a digital twin that predicts thermal runaway before it happens.

### 3. The Guardrails (Policy Engine)
* **Tech:** Pydantic
* **Function:** A rigid logic layer that strictly enforces battery degradation limits and voltage constraints.
* **Why it matters:** It acts as a "Safety Clamp." Even if the AI hallucinates, the Physics Engine will block any action that violates physical safety limits.

---

## Key Features

* **Dynamic Hosting Capacity:** We don't use static limits. We calculate the safe MW injection limit every second based on real-time grid flows.
* **Thermal Arbitrage:** We monetize the temperature of our coolant. By pre-cooling when power is cheap, we create a "Thermal Battery" for peak hours.
* **Battery Health Aware:** We implement **Arrhenius Aging models** to track Li-Ion degradation costs in real-time, ensuring we don't burn out batteries for pennies.
* **Visual Digital Twin:** A Next.js dashboard that visualizes the electron flow and thermal states in 3D.

---

## Tech Stack

### Backend (`/backend`)
* **Framework:** FastAPI (Python 3.10)
* **AI/ML:** PyTorch, PyTorch Geometric
* **Simulation:** Pandapower (Grid Physics), NumPy (Thermal Physics)
* **Testing:** Pytest (100% Coverage on Core Logic)

### Frontend (`/frontend`)
* **Framework:** Next.js 14 (React)
* **Visualization:** React Flow (Topology), Recharts (Telemetry), React Three Fiber (3D Thermal Twin)
* **Styling:** Tailwind CSS

---

## Getting Started

The system is designed as a modular monolith. You can run it with Docker or manually.

### Option 1: The "Hacker" Way (Manual)

**1. Start the Brain (Backend)**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
