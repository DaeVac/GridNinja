from fastapi.testclient import TestClient
import pandapower as pp
# We mock pandapower in case it is slow or has heavy init issues in test environment
# But the plan asked for "Real" integration, so we should try to run it real if possible.
# However, for speed and stability in CI, we usually mock external physics libs.
# Let's try real first, as requested.

def test_grid_topology_structure(client: TestClient):
    """
    Verify /grid/topology returns valid node-link data.
    """
    response = client.get("/grid/topology")
    assert response.status_code == 200
    data = response.json()
    
    assert "nodes" in data
    assert "edges" in data
    assert "meta" in data
    
    # Check bus count (33 for IEEE-33)
    # Note: Our pandapower service normalizes to 1..33
    assert len(data["nodes"]) == 33
    # Check lines (usually 32 lines for radial 33 bus)
    # verify edges count roughly
    assert len(data["edges"]) >= 32
    
    # Check structure of a node
    node = data["nodes"][0]
    assert "x" in node
    assert "y" in node
    assert "kind" in node
    assert node["kind"] in ["substation", "dc", "pv", "load"]

def test_grid_predict_endpoint(client: TestClient):
    """
    Verify /grid/predict returns headroom for a node.
    """
    # Node 18 is our DC
    response = client.get("/grid/predict?node_id=18")
    # If GNNService falls back (dependencies missing/mocked), it should still return 200
    assert response.status_code == 200
    data = response.json()
    
    assert data["node_id"] == "18"
    assert "safe_shift_kw" in data
    assert "reason_code" in data
    assert isinstance(data["safe_shift_kw"], float)
    
def test_grid_predict_invalid_node(client: TestClient):
    """
    Verify validation on node_id.
    """
    response = client.get("/grid/predict?node_id=999")
    # FastAPI validation error
    assert response.status_code == 422
