/**
 * Tests for the KeyHandler component.
 *
 * Uses ink-testing-library for component-level render/input simulation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { KeyHandler } from "./key-handler";

afterEach(() => {
  cleanup();
});

describe("KeyHandler — single binding", () => {
  test("fires callback when the bound key is pressed", async () => {
    const cb = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ c: cb }}>
        <Text>Press c to copy</Text>
      </KeyHandler>,
    );

    stdin.write("c");
    await new Promise((r) => setTimeout(r, 30));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test("does not fire callback for an unbound key", async () => {
    const cb = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ c: cb }}>
        <Text>Press c to copy</Text>
      </KeyHandler>,
    );

    stdin.write("x"); // not bound
    await new Promise((r) => setTimeout(r, 30));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("KeyHandler — multiple bindings", () => {
  test("fires the correct callback for each key", async () => {
    const cbA = mock(() => {});
    const cbB = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ a: cbA, b: cbB }}>
        <Text>Press a or b</Text>
      </KeyHandler>,
    );

    stdin.write("a");
    await new Promise((r) => setTimeout(r, 30));
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).not.toHaveBeenCalled();

    stdin.write("b");
    await new Promise((r) => setTimeout(r, 30));
    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbA).toHaveBeenCalledTimes(1); // still just once
  });

  test("ctrl+c binding fires when ctrl+c is pressed", async () => {
    const ctrlC = mock(() => {});
    const other = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ "ctrl+c": ctrlC, q: other }}>
        <Text>Ctrl+C to cancel</Text>
      </KeyHandler>,
    );

    stdin.write("\x03"); // Ctrl+C
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrlC).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  test("ignores keys that have no binding", async () => {
    const cbQ = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ q: cbQ }}>
        <Text>q to quit</Text>
      </KeyHandler>,
    );

    stdin.write("a");
    stdin.write("b");
    stdin.write("c");
    await new Promise((r) => setTimeout(r, 30));
    expect(cbQ).not.toHaveBeenCalled();
  });
});

describe("KeyHandler — rendering", () => {
  test("renders children content", () => {
    const { lastFrame } = render(
      <KeyHandler bindings={{}}>
        <Text>Press c to copy URL</Text>
      </KeyHandler>,
    );
    expect(lastFrame()).toContain("Press c to copy URL");
  });

  test("renders with empty bindings and no children", () => {
    // Should not throw
    const { lastFrame } = render(<KeyHandler bindings={{}} />);
    expect(lastFrame()).toBeDefined();
  });
});

describe("KeyHandler — space binding", () => {
  test("'space' binding fires when space is pressed", async () => {
    const cbSpace = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ space: cbSpace }}>
        <Text>space</Text>
      </KeyHandler>,
    );

    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 30));
    expect(cbSpace).toHaveBeenCalledTimes(1);
  });

  test("' ' (space char) binding fires when space is pressed", async () => {
    const cbSpace = mock(() => {});
    const { stdin } = render(
      <KeyHandler bindings={{ " ": cbSpace }}>
        <Text>space char binding</Text>
      </KeyHandler>,
    );

    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 30));
    expect(cbSpace).toHaveBeenCalledTimes(1);
  });
});
