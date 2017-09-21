let BaseStrategy = require('./basestrategy').BaseStrategy;

// Не хватает elevator.x

const EL_STATE = {
    waiting: 0,
    moving: 1,
    opening: 2,
    filling: 3,
    closing: 4
};
const PAS_STATE = {
    waitingForElevator: 0,
    movingToElevator: 1,
    returning: 2,
    movingToFloor: 3,
    usingElevator: 4,
    exiting: 5
};
const PAS_HORIZONTAL_SPEED = 2;
const CLOSE_DOORS_TICKS = 100;
const OPEN_DOORS_TICKS = 100;
const EMPTY_ONE_FLOOR_TICKS = 50;

class Plan {
    constructor() {
        this.actions = [];
        this.ticks = 0;
        this.score = 0;
    }
    //creates copy
    addAction(action) {
        const newPlan = Object.assign({}, this);
        newPlan.actions = newPlan.actions.slice();
        newPlan.actions.push(action);
        newPlan.ticks += action.ticks;
        newPlan.score += action.score;
        return newPlan;
    }
}

class WaitAction {
    constructor(elevator, passengersToWait) {
        this.elevator = elevator;
        this.passengers = passengersToWait;
    }
    get ticks() {
        let maxTime = 0;
        this.passengers.forEach(p => {
            const timeToCome = Math.floor(Math.abs(p.x - this.elevator.x) / PAS_HORIZONTAL_SPEED) + 1;
            const enemyDelay = p.type === this.elevator.type ? 0 : Math.max(0, 40 - this.elevator.timeOnFloor);
            const factTime = timeToCome + enemyDelay;
            maxTime = Math.max(maxTime, factTime);
        });
        return maxTime;
    }
    static get score() {
        return 0;
    }
    //MUTATES PASSENGERS!
    execute(elevator, myPassengers, enemyPassengers) {
        this._setElevatorToPassengers(myPassengers);
        this._setElevatorToPassengers(enemyPassengers);
    }
    _setElevatorToPassengers(passengers) {
        passengers.forEach(p => {
            if (this.passengers.find(wp => wp.id === p.id)) {
                p.setElevator(this.elevator);
            }
        })
    }
}

class GoAction {
    constructor(elevator, floor, passengers = []) {
        this.elevator = elevator;
        this.floor = floor;
        this.passengers = passengers;
    }
    get ticks() {
        if (this.passengers.length === 0 || this.floor < this.elevator.floor) {
            return Math.abs(this.elevator.floor - this.floor) * EMPTY_ONE_FLOOR_TICKS;
        } else {
            const weightFactor = this.elevator.passengers.reduce((acc, p) => acc * p.weight, 1);
            const overweightFactor = this.elevator.passengers.length > 10 ? 1.1 : 1;
            const oneFloorTicks = EMPTY_ONE_FLOOR_TICKS * weightFactor * overweightFactor;
            const movingTicks = Math.abs(this.elevator.floor - this.floor) * oneFloorTicks;
            return CLOSE_DOORS_TICKS + movingTicks + OPEN_DOORS_TICKS
        }
    }
    get score() {
        return this.passengers.reduce((acc, p) => {
            return acc + Math.abs(p.fromFloor - p.destFloor) * 10 * (this.elevator.type === p.type ? 1 : 2);
        }, 0);
    }
    //MUTATES ELEVATOR!
    execute(elevator, myPassengers, enemyPassengers) {
        elevator.goToFloor(this.floor);
    }
}

class Strategy extends BaseStrategy {

    static maxPlanLength = 6;

    static curTick = 0;
    static gameLen = 7200;

    //takes original objects from server
    //prepare them and use that data to find best plan
    generatePlan(elevator, myPassengers, enemyPassengers) {

        let bestPlan;

        const emulateAction = (action, elevator, passengers, curPlan) => {
            const tickAfterAction = this.curTick + curPlan.ticks + action.ticks;
            if (tickAfterAction <= this.gameLen) { //add break on max plan ticks?
                const {newElev, newPass} = this.emulate(elevator, passengers, action);
                _generatePlan(newElev, newPass, curPlan.addAction(action));
            }
        };

        const distinct = (passengersToWait, i, arr) => {
            return arr.findIndex(pass => pass.length === passengersToWait.length) === i;
        };

        //new plan is better if it's score larger or, if scores equals, if it's ticks less
        const setAsBestIfBetter = (plan) => {
            if (!bestPlan ||
                plan.score > bestPlan.score ||
                (plan.score === bestPlan.score && plan.ticks < bestPlan.ticks)) {
                bestPlan = plan;
            }
        };

        //takes original elevator and prepared passengers
        const _generatePlan = (elevator, passengers, curPlan = new Plan()) => {
            if (curPlan.actions.length === this.maxPlanLength) {
                setAsBestIfBetter(curPlan);
            } else {
                const curPassengersAmount = elevator.passengers.length;
                let canBuildPlanFurther = false;
                //1. if there is someone on the floor, try to fill elevator with different amounts of passengers
                if (passengers[elevator.floor].length) {
                    [4, 10, 20]
                        .map(n => n - curPassengersAmount) //how much is needed
                        .filter(n => n > 0)
                        .map(n => passengers[elevator.floor].slice(0, n)) //take first (best) n passengers
                        .filter(distinct) //same passenger arrays will produce same plan points so ignore them
                        .forEach(passengersToWait => {
                            canBuildPlanFurther = true;
                            const waitAction = new WaitAction(elevator, passengersToWait);
                            emulateAction(waitAction, elevator, passengers, curPlan);
                        });
                }
                //2. anyway, try to go to some floor, floors with max destinations check first
                [1, 2, 3, 4, 5, 6, 7, 8, 9]
                    .map(i => elevator.passengers.filter(p => p.destFloor === i))
                    .map((p, i) => {
                        p.floor = i; //set floor to passengers array
                        return p;
                    })
                    .sort((p1, p2) => p2.length - p1.length)
                    .forEach(passengerz => {
                        //there is somebody in elevator wanting on passengerz.floor
                        if (passengerz.length) {
                            canBuildPlanFurther = true;
                            const goAction = new GoAction(elevator, passengerz.floor, passengerz);
                            emulateAction(goAction, elevator, passengers, curPlan);
                        //there is no one in elevator wanting on passengerz.floor
                        //then check if someone is staying on that floor
                        } else {
                            const goAction = new GoAction(elevator, passengerz.floor);
                            const goActionTicks = goAction.ticks; //calc one time for that block
                            const passengersWillNotGoStairs = passengers[passengerz.floor].filter(p => {
                                return p.timeToAway >= goActionTicks;
                            });
                            if (passengerz.floor !== elevator.floor && passengersWillNotGoStairs.length) {
                                canBuildPlanFurther = true;
                                emulateAction(goAction, elevator, passengers, curPlan);
                            }
                        }
                    });
                if (!canBuildPlanFurther) {
                    setAsBestIfBetter(curPlan);
                }
            }
        };

        _generatePlan(elevator, this.preparePassengers(elevator, myPassengers, enemyPassengers));
        return bestPlan;
    }

    preparePassengers(elevator, myPassengers, enemyPassengers) {
        const curPassengersAmount = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            .map(floor => elevator.passengers.filter(p => p.destFloor === floor).length);
        const passengers = new Array(10).fill([]);
        myPassengers.concat(enemyPassengers)
            .filter(p => p.state === PAS_STATE.waitingForElevator || p.state === PAS_STATE.returning)
            .forEach(p => passengers[p.floor].push(p));
        passengers.forEach(passengerz => passengerz.sort((p1, p2) => {
            const score1 = curPassengersAmount[p1.destFloor] * 1000 - Math.abs(elevator.x - p1.x);
            const score2 = curPassengersAmount[p2.destFloor] * 1000 - Math.abs(elevator.x - p2.x);
            return score2 - score1;
        }));
        return passengers;
    }

    emulate(elevator, passengers, action) {
        //creating copies of elevator and passengers
        let newElev = Object.assign({}, elevator);
        newElev.passengers = newElev.passengers.map(p => Object.assign({}, p));
        let newPass = passengers.map(passengerz => passengerz.map(p => Object.assign({}, p)));
        if (action instanceof WaitAction) {
            //add new passengers to elevator
            const comingPassengers = action.passengers.map(p => Object.assign({}, p));
            newElev.passengers = newElev.passengers.concat(comingPassengers);
            //remove them from waiting list
            newPass[elevator.floor] = subtract(newPass[elevator.floor], comingPassengers);
        } else if (action instanceof GoAction) {
            //remove passengers from elevator
            newElev.passengers = subtract(newElev.passengers, action.passengers);
        }
        return {
            newElev,
            newPass
        }
    }

    onTick(myPassengers, myElevators, enemyPassengers, enemyElevators) {
        if (this.curTick % 200 === 0) {
            this.debug(myElevators);
        }
        let myPassengerz = myPassengers.map(p => Object.assign({}, p));
        let enemyPassengerz = enemyElevators.map(p => Object.assign({}, p));
        myElevators.forEach(elevator => {
            const plan = this.generatePlan(elevator, myPassengerz, enemyPassengerz);
            if (plan.actions.length) {
                plan.actions[0].execute(elevator, myPassengers, enemyPassengers);
                //Remove passengers which current elevator plan to lift
                plan.actions.forEach(action => {
                    if (action instanceof WaitAction) {
                        myPassengerz = subtract(myPassengerz, action.passengers);
                        enemyPassengerz = subtract(enemyPassengerz, action.passengers);
                    }
                });
            } else {
                const floor = this.curTick <= 1400 ? 1 : (this.curTick <= 6000 ? 5 : 9);
                elevator.goToFloor(floor);
            }
        });
        this.curTick += 1;
    }
}

function subtract(initial, subtractor) {
    return initial.filter(p => {
        return !subtractor.find(ap => ap.id === p.id);
    })
}

module.exports.Strategy = Strategy;
