// A small physical spring, simulated step by step (semi-implicit Euler).
// Several of these animate the island's width, height and corner radius together.
const STEP = 1 / 240;

export class Spring {
    constructor(value = 0) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.stiffness = 300;
        this.damping = 26;
    }

    // speed: 1 is normal, 2 twice as fast. bounce: 0 (none) .. 1 (very wobbly)
    configure(speed, bounce) {
        this.stiffness = 300 * speed * speed;
        // Critical damping is 2*sqrt(k); less of it gives the overshoot
        const critical = 2 * Math.sqrt(this.stiffness);
        this.damping = critical * (1 - 0.6 * Math.max(0, Math.min(1, bounce)));
    }

    jump(value) {
        this.value = this.target = value;
        this.velocity = 0;
    }

    advance(dt) {
        let left = Math.min(dt, 0.1);
        while (left > 0) {
            const h = Math.min(STEP, left);
            const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
            this.velocity += force * h;
            this.value += this.velocity * h;
            left -= h;
        }
        if (this.settled)
            this.jump(this.target);
    }

    get settled() {
        return Math.abs(this.value - this.target) < 0.3 && Math.abs(this.velocity) < 2;
    }
}
