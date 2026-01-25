import { auth0 } from "@/lib/auth0";
import LoginButton from "@/components/LoginButton";
import LogoutButton from "@/components/LogoutButton";

export default async function Home() {
  const session = await auth0.getSession();
  const user = session?.user;

  return (
    <div className="app-container">
      <div className="team-row">
        <img src="/Neutron.0.GIF" alt="logo" />
        <img src="/teamName.svg" alt="Team Name" />
      </div>
      <div className="header-container">
        <div className="video-container">
          <video autoPlay muted loop playsInline>
            <source src="/Video Project.mp4" type="video/mp4" />
          </video>
        </div>

        <h1 className="main-title">
          Optimize your Power Grid with AI
        </h1>
      </div>
      <div className="login-button-container">
        {user ? <LogoutButton /> : <LoginButton />}
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
