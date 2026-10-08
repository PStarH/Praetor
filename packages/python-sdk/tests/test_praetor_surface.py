"""Test canonical praetor package surface and aliases."""

import pytest
import praetor
import commander


def test_praetor_exports() -> None:
    assert hasattr(praetor, "PraetorClient")
    assert hasattr(praetor, "CommanderClient")
    assert hasattr(praetor, "PraetorGatewayClient")
    assert hasattr(praetor, "PraetorError")
    assert hasattr(praetor, "CommanderError")
    assert hasattr(praetor, "Agent")
    assert hasattr(praetor, "Topology")

    assert praetor.PraetorClient is praetor.CommanderClient
    assert praetor.PraetorError is praetor.CommanderError
    assert praetor.PraetorGatewayClient is praetor.CommanderGatewayClient


def test_commander_shim_identity() -> None:
    assert commander.CommanderClient is praetor.CommanderClient
    assert commander.CommanderError is praetor.CommanderError
    assert commander.Agent is praetor.Agent
    assert commander.Topology is praetor.Topology
