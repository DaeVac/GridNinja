import Image from "next/image";
import { auth0Configured, getSessionSafe } from "@/lib/auth0";
import LoginButton from "@/components/LoginButton";
import LogoutButton from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSessionSafe();
  const user = session?.user;

  return (
    <div className="app-container">
      <div className="team-row">
        <Image
          src="/Neutron.0.GIF"
          alt="Neutron logo"
          width={60}
          height={60}
          priority
          unoptimized
        />
        <Image
          src="/teamName.svg"
          alt="GridNinja"
          width={180}
          height={60}
          priority
        />
      </div>
      <div className="header-container">
        <div className="video-container" aria-hidden="true">
          <video autoPlay muted loop playsInline preload="none" poster="/tempLogo.svg">
            <source src="/Video Project.mp4" type="video/mp4" />
          </video>
        </div>

        <div className="hero-text">
          <h1 className="main-title">Optimize your Power Grid</h1>
          <p className="hero-subtitle">
            Real-time telemetry, thermal headroom, and AI dispatching to keep
            your grid stable while maximizing savings.
          </p>
          <div className="hero-pills">
            <span className="hero-pill">Live telemetry</span>
            <span className="hero-pill">Thermal twin</span>
            <span className="hero-pill">Safe shift control</span>
          </div>
        </div>
      </div>
      <div className="login-button-container">
        {auth0Configured ? (
          user ? <LogoutButton /> : <LoginButton />
        ) : (
          <a href="/dashboard" className="button login">
            Fake Log In
          </a>
        )}
      </div>

      {/* <div className="main-card-wrapper">
        <img
          src="https://cdn.auth0.com/quantum-assets/dist/latest/logos/auth0/auth0-lockup-en-ondark.png"
          alt="Auth0 Logo"
          className="auth0-logo"
        />
        <h1 className="main-title">GridNinja</h1>
        
        <div className="action-card">
          {user ? (
            <div className="logged-in-section">
              <p className="logged-in-message">✅ Successfully logged in!</p>
              <Profile />
              <LogoutButton />
            </div>
          ) : (
            <>
              <p className="action-text">
                Welcome! Please log in to access Power Grid Data.
              </p>
              <LoginButton />
            </>
          )}
        </div>
      </div> */}
    </div>
  );
}
